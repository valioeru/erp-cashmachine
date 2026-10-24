"use strict";
// Depozitul CT-Park, desenat la scară: secțiunea transversală prin rafturi,
// exact cum arată planul de montaj.
//
// Tot desenul se naște din constantele de mai jos, în milimetri. Dacă se mai
// adaugă un rând, se mută un culoar sau se schimbă adâncimea raftului, se
// schimbă cifra aici și desenul, cotele și tabelul de trasare se refac
// singure — nu se umblă în SVG cu mâna. Sistemul de coordonate al desenului
// e tot în milimetri (viewBox), deci ce citești în cod e ce se măsoară pe
// hârtie.
const db = require("../lib/db");
const { SUB_STOC } = require("../lib/stoc");
const { esc, layout, table, dateleInText } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Planul halei. Erau constante scrise în sursă — acum sunt DATE: se pot
// schimba din „Planul halei", fără să umble cineva prin cod. Valorile de aici
// rămân cele din planul de montaj și se folosesc cât timp nu s-a salvat
// altceva. Sunt stare de aplicație, nu de cerere: se citesc o dată la pornire
// și se rescriu după fiecare salvare, de-aia stau în modul și nu se cară prin
// toate funcțiile de desen.
let ADANCIME = 1100; // adâncimea unui rând de raft, văzută în secțiune
let SPATE = 200; // jocul dintre două rânduri așezate spate în spate
let CULOAR = 3200; // culoarul de lucru dintre grupuri
const CONSOLA = 50; // cât iese structura de sus în afara cadrului, pe fiecare parte
const MONTANT = 100; // lățimea profilului montantului

// Înălțimile, măsurate de la pardoseală. Planul nu cotează pe verticală, așa
// că valorile astea sunt luate din proporțiile desenului — se pot corecta
// aici fără să se strice nimic altceva.
const INALTIME = 9100;
const BAZA = 130;
const CONTRAV_JOS = 180;
const CONTRAV_SUS = 5980;
const CONTRAV_CAMPURI = 4;
const NIVEL_JOS = 6400;
const NIVEL_SUS = 8150;

// Rândurile, în ordinea în care stau în hală de la stânga la dreapta.
// Grupate cum sunt și în realitate: două rânduri lipite spate în spate fac
// un grup, între grupuri rămâne culoarul.
let GRUPURI = [[8], [7, 6], [5, 4], [3, 2], [1]];

const PLAN_IMPLICIT = { grupuri: GRUPURI, adancime: ADANCIME, spate: SPATE, culoar: CULOAR };

const MARGINE_X = 900;
const MARGINE_SUS = 1500;
const MARGINE_JOS = 2650;

const CULORI = {
  montant: "#3f5fc4",
  contravantuire: "#b9bcc2",
  nivel: "#c8781f",
  talpa: "#e3b23c",
  pardoseala: "#8a8f98",
  cota: "#1f2328",
};

// Poziția fiecărui rând, în milimetri de la marginea din stânga a halei.
function pozitii() {
  const rez = [];
  let x = 0;
  GRUPURI.forEach((grup, gi) => {
    if (gi) x += CULOAR;
    grup.forEach((nr, i) => {
      if (i) x += SPATE;
      rez.push({ nr, x, grup: gi });
      x += ADANCIME;
    });
  });
  return rez;
}

const y = (deLaPardoseala) => INALTIME - deLaPardoseala;

// --- cărămizile desenului ---------------------------------------------------

function sageata(x, yy, spre) {
  const l = 150;
  const h = 55;
  const s = spre === "stanga" ? 1 : -1;
  return `<polygon points="${x},${yy} ${x + s * l},${yy - h} ${x + s * l},${yy + h}" fill="${CULORI.cota}"/>`;
}

// O cotă orizontală: linie cu săgeți la capete, liniile ajutătoare le pune
// apelantul (sunt comune mai multor cote).
function cota(x1, x2, yy, text, sub) {
  const mij = (x1 + x2) / 2;
  const inauntru = x2 - x1 > 900;
  return `
    <line x1="${x1}" y1="${yy}" x2="${x2}" y2="${yy}" stroke="${CULORI.cota}" stroke-width="1" vector-effect="non-scaling-stroke"/>
    ${inauntru ? sageata(x1, yy, "stanga") + sageata(x2, yy, "dreapta") : ""}
    ${inauntru ? "" : sageata(x1, yy, "dreapta") + sageata(x2, yy, "stanga")}
    <text x="${mij}" y="${sub ? yy + 420 : yy - 160}" text-anchor="middle" font-size="300" fill="${CULORI.cota}">${esc(text)}</text>`;
}

// Un rând de raft: doi montanți, tălpile lor, contravântuirea în X pe zona de
// jos și cadrul de sus (cel portocaliu din plan), care iese cu 50 mm în
// culoar de fiecare parte.
function rand(r) {
  const xs = r.x;
  const xd = r.x + ADANCIME;
  const intS = xs + MONTANT;
  const intD = xd - MONTANT;

  const montant = (mx) => `
    <rect x="${mx}" y="${y(INALTIME)}" width="${MONTANT}" height="${INALTIME}" fill="none" stroke="${CULORI.montant}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <line x1="${mx + MONTANT / 2}" y1="${y(INALTIME)}" x2="${mx + MONTANT / 2}" y2="${y(0)}" stroke="${CULORI.montant}" stroke-width="0.6" vector-effect="non-scaling-stroke" opacity="0.7"/>`;

  const talpa = (mx) => `
    <rect x="${mx - 60}" y="${y(BAZA)}" width="${MONTANT + 120}" height="${BAZA}" fill="none" stroke="${CULORI.talpa}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;

  // contravântuirea: câmpuri suprapuse de X, ca în plan
  const pas = (CONTRAV_SUS - CONTRAV_JOS) / CONTRAV_CAMPURI;
  let contra = "";
  for (let i = 0; i < CONTRAV_CAMPURI; i++) {
    const jos = CONTRAV_JOS + i * pas;
    const sus = jos + pas;
    contra += `
      <line x1="${intS}" y1="${y(jos)}" x2="${intD}" y2="${y(sus)}" stroke="${CULORI.contravantuire}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      <line x1="${intD}" y1="${y(jos)}" x2="${intS}" y2="${y(sus)}" stroke="${CULORI.contravantuire}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  }

  // cadrul de sus, cu diagonalele și grinda dublă de la bază
  const nx = xs - CONSOLA;
  const nl = ADANCIME + 2 * CONSOLA;
  const nivel = `
    <rect x="${nx}" y="${y(NIVEL_SUS)}" width="${nl}" height="${NIVEL_SUS - NIVEL_JOS}" fill="none" stroke="${CULORI.nivel}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <line x1="${nx}" y1="${y(NIVEL_JOS)}" x2="${nx + nl}" y2="${y(NIVEL_SUS)}" stroke="${CULORI.nivel}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
    <line x1="${nx + nl}" y1="${y(NIVEL_JOS)}" x2="${nx}" y2="${y(NIVEL_SUS)}" stroke="${CULORI.nivel}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
    <line x1="${nx}" y1="${y(NIVEL_JOS - 190)}" x2="${nx + nl}" y2="${y(NIVEL_JOS - 190)}" stroke="${CULORI.nivel}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <line x1="${nx}" y1="${y(NIVEL_JOS - 190)}" x2="${nx}" y2="${y(NIVEL_JOS)}" stroke="${CULORI.nivel}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
    <line x1="${nx + nl}" y1="${y(NIVEL_JOS - 190)}" x2="${nx + nl}" y2="${y(NIVEL_JOS)}" stroke="${CULORI.nivel}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
    <line x1="${xs + ADANCIME * 0.35}" y1="${y(NIVEL_JOS - 190)}" x2="${xs + ADANCIME * 0.35}" y2="${y(NIVEL_JOS)}" stroke="${CULORI.nivel}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>
    <line x1="${xs + ADANCIME * 0.65}" y1="${y(NIVEL_JOS - 190)}" x2="${xs + ADANCIME * 0.65}" y2="${y(NIVEL_JOS)}" stroke="${CULORI.nivel}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>
    <rect x="${xs + ADANCIME * 0.42}" y="${y(NIVEL_SUS + 260)}" width="${ADANCIME * 0.16}" height="180" fill="none" stroke="${CULORI.nivel}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`;

  // semnele mici galbene de pe montanți, la nodurile de prindere
  const semne = [NIVEL_JOS - 520, CONTRAV_SUS - 120, CONTRAV_JOS + 60, INALTIME - 480]
    .map(
      (h) =>
        `<rect x="${intS - 40}" y="${y(h)}" width="80" height="150" fill="none" stroke="${CULORI.talpa}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>
         <rect x="${intD - 40}" y="${y(h)}" width="80" height="150" fill="none" stroke="${CULORI.talpa}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`
    )
    .join("");

  return `
    <g class="rand" data-rand="${r.nr}" data-x="${r.x}" tabindex="0" role="button" aria-label="Rândul ${r.nr}">
      <rect class="zona" x="${xs - CONSOLA - 120}" y="${y(INALTIME + 700)}" width="${ADANCIME + 2 * CONSOLA + 240}" height="${INALTIME + 900}" fill="transparent"/>
      ${contra}
      ${montant(xs)}
      ${montant(xd - MONTANT)}
      ${talpa(xs)}
      ${talpa(xd - MONTANT)}
      ${semne}
      ${nivel}
      <text class="eticheta" x="${xs + ADANCIME / 2}" y="${y(INALTIME + 380)}" text-anchor="middle" font-size="430" fill="${CULORI.cota}">${r.nr}</text>
    </g>`;
}

function desen() {
  const poz = pozitii();
  const latime = poz[poz.length - 1].x + ADANCIME;

  // liniile ajutătoare + lanțul de cote de sub pardoseală
  const yCota = y(0) + 1150;
  const yCota2 = y(0) + 1900;
  let ajutatoare = "";
  let cote = "";
  const muchii = [];
  poz.forEach((r) => {
    muchii.push(r.x, r.x + ADANCIME);
  });
  [...new Set(muchii)].forEach((mx) => {
    ajutatoare += `<line x1="${mx}" y1="${y(0) + 120}" x2="${mx}" y2="${yCota + 260}" stroke="${CULORI.cota}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
  });
  poz.forEach((r, i) => {
    cote += cota(r.x, r.x + ADANCIME, yCota, String(ADANCIME));
    const urm = poz[i + 1];
    if (urm && urm.grup !== r.grup) cote += cota(r.x + ADANCIME, urm.x, yCota, String(CULOAR));
  });
  // jocul spate în spate: prea îngust ca să încapă cota pe lanț, deci stă pe
  // al doilea rând, sub perechea la care se referă
  GRUPURI.forEach((grup, gi) => {
    if (grup.length < 2) return;
    const p = poz.filter((r) => r.grup === gi);
    const x1 = p[0].x + ADANCIME;
    const x2 = p[1].x;
    cote += `
      <line x1="${x1}" y1="${yCota + 260}" x2="${x1}" y2="${yCota2}" stroke="${CULORI.cota}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>
      <line x1="${x2}" y1="${yCota + 260}" x2="${x2}" y2="${yCota2}" stroke="${CULORI.cota}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>
      ${cota(x1, x2, yCota2, String(SPATE), true)}`;
  });

  // cota dintre cadrele de sus, peste culoar (cea din plan, 3100)
  const p2 = poz[poz.length - 2];
  const p1 = poz[poz.length - 1];
  const yPeste = y(NIVEL_SUS - 700);
  const coteSus = cota(p2.x + ADANCIME + CONSOLA, p1.x - CONSOLA, yPeste, String(CULOAR - 2 * CONSOLA));

  const vbX = -MARGINE_X;
  const vbY = -MARGINE_SUS;
  const vbW = latime + 2 * MARGINE_X;
  const vbH = INALTIME + MARGINE_SUS + MARGINE_JOS;

  return `
    <svg class="ct-desen" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" role="img"
         aria-label="Secțiune transversală prin rafturile depozitului CT-Park">
      <line x1="${-MARGINE_X + 200}" y1="${y(0)}" x2="${latime + MARGINE_X - 200}" y2="${y(0)}" stroke="${CULORI.pardoseala}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      <line x1="${-MARGINE_X + 200}" y1="${y(0) + 120}" x2="${latime + MARGINE_X - 200}" y2="${y(0) + 120}" stroke="${CULORI.pardoseala}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      ${poz.map(rand).join("")}
      <g class="cote">${ajutatoare}${cote}${coteSus}</g>
    </svg>`;
}

// --- pagina -----------------------------------------------------------------

async function paginaSectiune(ctx) {
    const poz = pozitii();
    const latime = poz[poz.length - 1].x + ADANCIME;

    // Locațiile deja definite în ERP, cu stocul lor. Rândurile din desen nu
    // sunt încă legate de ele: cât timp nu știm care rând e care gestiune,
    // e mai cinstit să le arătăm alături decât să inventăm o potrivire.
    let locatii = [];
    try {
      locatii = await db
        .prepare(
          `SELECT d.id, d.denumire, d.locatie,
                  COUNT(DISTINCT s.produs_id) AS produse,
                  COALESCE(SUM(s.stoc), 0) AS stoc
             FROM depozite d
             LEFT JOIN ${SUB_STOC} s ON s.depozit_id = d.id
            GROUP BY d.id, d.denumire, d.locatie
            ORDER BY d.denumire`
        )
        .all();
    } catch (e) {
      locatii = [];
    }

    const randuriTabel = poz
      .slice()
      .sort((a, b) => a.nr - b.nr)
      .map(
        (r) => `<tr data-rand="${r.nr}">
          <td><strong>${r.nr}</strong></td>
          <td>${(r.x / 1000).toFixed(1)} m</td>
          <td>${((r.x + ADANCIME) / 1000).toFixed(1)} m</td>
          <td>${GRUPURI[r.grup].length > 1 ? "spate în spate" : "rând simplu"}</td>
        </tr>`
      )
      .join("");

    const body = `
      ${subtabs("/stocuri/ct-park/sectiune")}
      <div class="ct-antet">
        <div>
          <h2 style="margin:0">Depozit CT-Park — secțiune prin rafturi</h2>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">
            Desenul e la scară, din cotele de montaj: ${poz.length} rânduri de raft de ${ADANCIME} mm,
            lipite câte două la ${SPATE} mm, cu ${GRUPURI.length - 1} culoare de ${CULOAR} mm între grupuri.
          </p>
        </div>
        <label class="ct-comutator"><input type="checkbox" id="ct-cote" checked> cote</label>
      </div>

      <div class="cards">
        <div class="card"><div class="label">Rânduri de raft</div><div class="value">${poz.length}</div></div>
        <div class="card"><div class="label">Culoare de lucru</div><div class="value">${GRUPURI.length - 1} × ${(CULOAR / 1000).toFixed(1)} m</div></div>
        <div class="card"><div class="label">Lățime ocupată</div><div class="value">${(latime / 1000).toFixed(2)} m</div></div>
        <div class="card"><div class="label">Adâncime rând</div><div class="value">${(ADANCIME / 1000).toFixed(1)} m</div></div>
        <div class="card"><div class="label">Rând selectat</div><div class="value" id="ct-ales">—</div></div>
      </div>

      <div class="ct-plansa">${desen()}</div>

      <p class="ct-legenda">
        <span><i style="background:${CULORI.montant}"></i>montanți</span>
        <span><i style="background:${CULORI.contravantuire}"></i>contravântuiri</span>
        <span><i style="background:${CULORI.nivel}"></i>cadru superior</span>
        <span><i style="background:${CULORI.talpa}"></i>tălpi și prinderi</span>
        <span style="color:var(--text-muted)">Click pe un rând ca să-l evidențiezi.</span>
      </p>

      <h2>Trasare — poziția fiecărui rând</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">Distanțe măsurate de la marginea din stânga a zonei de rafturi (rândul 8).</p>
      <table class="table ct-tabel">
        <thead><tr><th>Rând</th><th>De la</th><th>Până la</th><th>Așezare</th></tr></thead>
        <tbody>${randuriTabel}</tbody>
      </table>

      <h2>Locații de stoc definite în ERP</h2>
      ${
        locatii.length
          ? `<table class="table"><thead><tr><th>Locație</th><th>Adresă</th><th>Produse</th><th>Stoc total</th></tr></thead><tbody>
              ${locatii
                .map(
                  (l) =>
                    `<tr><td><a href="/depozite/${l.id}/editare">${esc(l.denumire)}</a></td><td>${esc(l.locatie || "—")}</td><td>${l.produse || 0}</td><td>${Number(l.stoc || 0)}</td></tr>`
                )
                .join("")}
            </tbody></table>
            <p style="font-size:12px;color:var(--text-muted)">
              Desenul ăsta e planul de montaj, nu harta de lucru. Ce marfă stă efectiv în fiecare loc de palet se
              vede în <a href="/stocuri/ct-park">harta depozitului</a>.
            </p>`
          : `<p style="color:var(--text-muted)">Nicio locație definită încă. Se adaugă din <a href="/depozite">Locații</a>.</p>`
      }

      <style>
        .ct-antet { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:12px; }
        .ct-comutator { font-size:13px; color:var(--text-muted); display:flex; align-items:center; gap:6px; white-space:nowrap; }
        .ct-plansa { background:#fff; border:1px solid var(--border); border-radius:8px; padding:10px; overflow-x:auto; }
        .ct-desen { width:100%; min-width:900px; height:auto; display:block; }
        .ct-desen .rand { cursor:pointer; }
        .ct-desen .rand:hover .zona, .ct-desen .rand:focus .zona { fill:rgba(63,95,196,.07); }
        .ct-desen .rand.ales .zona { fill:rgba(63,95,196,.14); }
        .ct-desen .rand.ales .eticheta { font-weight:700; fill:var(--primary); }
        .ct-desen.fara-cote .cote { display:none; }
        .ct-legenda { display:flex; gap:18px; flex-wrap:wrap; align-items:center; font-size:12px; color:var(--text); margin:10px 0 18px; }
        .ct-legenda i { display:inline-block; width:12px; height:12px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
        .ct-tabel tr.ales td { background:rgba(63,95,196,.10); font-weight:600; }
      </style>
      <script>
        (function () {
          var desen = document.querySelector(".ct-desen");
          if (!desen) return;
          var ales = null;
          function alege(nr) {
            ales = ales === nr ? null : nr;
            desen.querySelectorAll(".rand").forEach(function (g) {
              g.classList.toggle("ales", g.dataset.rand === ales);
            });
            document.querySelectorAll(".ct-tabel tbody tr").forEach(function (tr) {
              tr.classList.toggle("ales", tr.dataset.rand === ales);
            });
            document.getElementById("ct-ales").textContent = ales ? "rândul " + ales : "—";
          }
          desen.querySelectorAll(".rand").forEach(function (g) {
            g.addEventListener("click", function () { alege(g.dataset.rand); });
            g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alege(g.dataset.rand); } });
          });
          document.querySelectorAll(".ct-tabel tbody tr").forEach(function (tr) {
            tr.style.cursor = "pointer";
            tr.addEventListener("click", function () { alege(tr.dataset.rand); });
          });
          var bifa = document.getElementById("ct-cote");
          if (bifa) bifa.addEventListener("change", function () { desen.classList.toggle("fara-cote", !bifa.checked); });
        })();
      </script>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "CT-Park — secțiune prin rafturi", active: "/stocuri/ct-park", body }));
}

// ===========================================================================
// HARTA DE LUCRU: rânduri → locuri de palet → marfă
//
// Desenul de mai sus e planul de montaj: bun când se ridică raftul, inutil
// când cauți o paletă. Partea asta e cealaltă jumătate — harta pe care o
// folosește omul din depozit.
//
// Structura e cea din hală, nu una inventată: un rând de raft are câmpuri
// (deschiderile dintre montanți) și niveluri; în fiecare câmp, la fiecare
// nivel, încap trei paleți unul lângă altul. Adresa unui loc e „R3-05-2-1" —
// rândul 3, câmpul 5, nivelul 2, poziția 1. Aia se scrie pe etichetă și aia
// se strigă în hală.
//
// Marfa lată stă pe două sau trei locuri, de-aia legătura paletă–loc e un
// tabel separat (ct_ocupari), nu o coloană: o paletă poate ține mai multe
// locuri, iar un loc e liber sau nu, indiferent câte locuri ține paleta de
// pe el.
// ===========================================================================

const CATEGORII = ["produse finite", "consumabile", "materie primă"];
const CULORI_CATEGORII = {
  "produse finite": "#2f7d4f",
  consumabile: "#8a5cc4",
  "materie primă": "#c07018",
};

const nr = (v) => Number(v || 0);
// „1 palet", nu „1 paleți". Mărunt, dar se citește de zeci de ori pe zi.
const plural = (n, unu, multi) => `${nr(n)} ${nr(n) === 1 ? unu : multi}`;
const procent = (v, z = 1) =>
  Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: z, maximumFractionDigits: z }) + "%";
const lei = (v) =>
  Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";

function aziStr() {
  return new Date().toISOString().slice(0, 10);
}

function doua(n) {
  return String(n).padStart(2, "0");
}

// Adresa unui loc. Ordinea e cea în care o caută omul: întâi rândul (unde
// merg), apoi câmpul (cât merg pe rând), apoi nivelul (unde ridic), apoi
// poziția (care din cele trei).
function adresaLoc(rand, camp, nivel, pozitie) {
  return `R${rand}-${doua(camp)}-${nivel}-${pozitie}`;
}

function codPaleta(id, data) {
  return `CT${String(data || aziStr()).replace(/-/g, "").slice(2)}-${String(id).padStart(4, "0")}`;
}

// Desenul tehnic de secțiune (rândul văzut din lateral, cu cotele de montaj)
// e scos din meniu: la treaba de zi cu zi nu ajută pe nimeni. Codul și ruta
// rămân întregi — se aprinde înapoi punând asta pe „true", și reapare în
// subnavigație exact unde era.
const ARATA_SECTIUNEA_TEHNICA = false;

function subtabs(activ) {
  const linkuri = [
    ["/stocuri/ct-park", "Harta depozitului"],
    ["/stocuri/ct-park/intrare", "Intrare marfă"],
    ["/stocuri/ct-park/iesire", "Ieșire marfă"],
    ["/stocuri/ct-park/stoc", "Stoc la zi"],
    ["/stocuri/ct-park/paleti", "Paleți în depozit"],
    ["/stocuri/ct-park/configurare", "Configurare rânduri"],
    ["/stocuri/ct-park/plan", "Planul halei"],
  ];
  if (ARATA_SECTIUNEA_TEHNICA) linkuri.push(["/stocuri/ct-park/sectiune", "Secțiune tehnică"]);
  return `<div class="subnav" style="margin-top:-6px">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

function pastila(categorie) {
  const c = String(categorie || "").trim();
  if (!c) return "";
  const culoare = CULORI_CATEGORII[c] || "#5a6472";
  return `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:${culoare}1a;color:${culoare};border:1px solid ${culoare}55">${esc(c)}</span>`;
}

// Mesajul de după o salvare: verde pentru "gata", roșu pentru "nu merge".
// Textul vine din adresa paginii, deci se scapă întotdeauna.
function mesaje(q) {
  const ok = String((q && q.ok) || "");
  const er = String((q && q.eroare) || "");
  return (
    (er ? `<div class="detail-box" style="border-left:4px solid var(--danger);max-width:860px">${esc(er)}</div>` : "") +
    (ok ? `<div class="detail-box" style="border-left:4px solid #2f7d4f;max-width:860px">${esc(ok)}</div>` : "")
  );
}

// Perechea de butoane care adaugă sau scoate un nivel. Stă în două formulare
// separate fiindcă fiecare e un POST de sine stătător — fără JavaScript, deci
// merge și pe telefonul din hală.
function butoaneNivel(r, inapoi) {
  const f = (spre, semn, titlu, dezactivat) => `<form method="post" action="/stocuri/ct-park/configurare/${r.id}/nivel" style="display:inline">
      <input type="hidden" name="spre" value="${spre}"><input type="hidden" name="inapoi" value="${inapoi || ""}">
      <button class="ct-mic" type="submit" title="${esc(titlu)}"${dezactivat ? " disabled" : ""}>${semn}</button>
    </form>`;
  return `<span class="ct-niv-ctrl">
      ${f("scoate", "−", "Scoate nivelul de sus", nr(r.niveluri) <= 1)}
      <strong>${nr(r.niveluri)}</strong>
      ${f("adauga", "+", "Adaugă un nivel deasupra", nr(r.niveluri) >= 12)}
    </span>`;
}

// Toate locurile unui rând, cu paleta de pe ele (dacă e vreuna). O paletă pe
// trei locuri apare de trei ori — o dată pe fiecare loc — și se strânge la
// desenare.
async function locuriRand(randId) {
  return db
    .prepare(
      `SELECT l.*, p.id AS palet_id, p.cod, p.produs_text, p.cantitate, p.um, p.lot,
              p.data_intrare, p.categorie AS palet_categorie, pr.denumire AS produs, pr.cod AS produs_cod
         FROM ct_locuri l
         LEFT JOIN ct_ocupari o ON o.loc_id = l.id
         LEFT JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
         LEFT JOIN produse pr ON pr.id = p.produs_id
        WHERE l.rand_id = ?
        ORDER BY l.nivel DESC, l.camp, l.pozitie`
    )
    .all(randId);
}


// Grosimea grinzii de sub un nivel. Intră în înălțimea totală a rândului, deci
// stă aici, nu în desen — se vede în cifrele de pe pagina de configurare.
const GRINDA = 140;

// O coloană adăugată ulterior poate să nu existe încă: fișierul cu migrarea
// se urcă separat de cel cu codul, iar între cele două deploy-uri baza e mai
// veche decât aplicația. O pagină n-are voie să cadă cu 500 din cauza asta —
// deci întrebăm baza ce coloane are și ne purtăm după. Răspunsul se ține minte
// pe toată viața procesului: schema nu se schimbă sub noi fără o repornire.
const coloaneStiute = new Map();
async function areColoana(tabel, coloana) {
  const cheie = tabel + "." + coloana;
  if (coloaneStiute.has(cheie)) return coloaneStiute.get(cheie);
  let are = false;
  try {
    const r = await db
      .prepare("SELECT 1 AS x FROM information_schema.columns WHERE table_name = ? AND column_name = ?")
      .get(tabel, coloana);
    are = Boolean(r);
  } catch (e) {
    are = false;
  }
  coloaneStiute.set(cheie, are);
  return are;
}

// ---- Planul halei, ținut în baza de date -----------------------------------
// Cheia „ct_plan" din setari_app. Dacă lipsește sau e stricată, rămân cifrele
// din planul de montaj de mai sus — depozitul nu trebuie să se strice din
// cauza unui JSON greșit.
const CHEIE_PLAN = "ct_plan";

function curataPlan(o) {
  if (!o || typeof o !== "object") return null;
  const grupuri = (Array.isArray(o.grupuri) ? o.grupuri : [])
    .map((g) => (Array.isArray(g) ? g.map((x) => Math.round(nr(x))).filter((x) => x >= 1 && x <= 99) : []))
    .filter((g) => g.length);
  if (!grupuri.length) return null;
  return {
    grupuri,
    adancime: Math.min(4000, Math.max(200, Math.round(nr(o.adancime)) || PLAN_IMPLICIT.adancime)),
    spate: Math.min(2000, Math.max(0, Math.round(nr(o.spate)))),
    culoar: Math.min(20000, Math.max(500, Math.round(nr(o.culoar)) || PLAN_IMPLICIT.culoar)),
  };
}

function aplicaPlan(p) {
  const c = curataPlan(p) || PLAN_IMPLICIT;
  GRUPURI = c.grupuri;
  ADANCIME = c.adancime;
  SPATE = c.spate;
  CULOAR = c.culoar;
  return c;
}

function planCurent() {
  return { grupuri: GRUPURI, adancime: ADANCIME, spate: SPATE, culoar: CULOAR };
}

async function incarcaPlan() {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(CHEIE_PLAN);
    if (r && r.valoare) return aplicaPlan(JSON.parse(r.valoare));
  } catch (e) {
    /* o bază fără setari_app sau un JSON stricat: rămân cifrele din cod */
  }
  return aplicaPlan(PLAN_IMPLICIT);
}

async function salveazaPlan(p) {
  const c = aplicaPlan(p);
  const acum = new Date().toISOString();
  const j = JSON.stringify(c);
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(CHEIE_PLAN).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(j, acum, CHEIE_PLAN);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(CHEIE_PLAN, j, acum);
  return c;
}

// Grupurile scrise ca text: un grup pe linie, numerele rândurilor despărțite
// prin spațiu sau virgulă. „7 6" pe o linie = două rânduri spate în spate.
// E cea mai simplă unealtă de proiectare care nu cere JavaScript: adaugi o
// linie, ai un grup nou; scoți un număr, ai un rând în minus.
function grupuriCaText(grupuri) {
  return grupuri.map((g) => g.join(" ")).join("\n");
}
function grupuriDinText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((linie) => linie.split(/[\s,;]+/).map((x) => Math.round(nr(x))).filter((x) => x >= 1 && x <= 99))
    .filter((g) => g.length);
}

// ---- Nivelurile unui rând --------------------------------------------------
// Tabelul ct_niveluri ține doar abaterile de la cifrele rândului: un nivel
// care nu are rând acolo moștenește înălțimea și numărul de paleți ale
// rândului. Funcția asta le pune la un loc, ca restul codului să nu mai știe
// că sunt două surse. De-aia un depozit configurat înainte merge mai departe
// fără nicio migrare.
async function niveluriRand(r, pana) {
  let salvate = [];
  try {
    salvate = await db.prepare("SELECT * FROM ct_niveluri WHERE rand_id = ? ORDER BY nivel").all(r.id);
  } catch (e) {
    salvate = [];
  }
  const h = new Map((salvate || []).map((x) => [nr(x.nivel), x]));
  const out = [];
  // `pana` e înălțimea celui mai înalt sector, când rândul are sectoare. Fără
  // ea, un sector de 5 niveluri pe un rând declarat de 3 n-ar avea niciodată
  // nivelurile 4 și 5 în listă, deci nici locuri generate acolo.
  const varf = Math.max(1, Math.round(nr(pana) || nr(r.niveluri)));
  for (let i = 1; i <= varf; i++) {
    const s = h.get(i) || {};
    out.push({
      nivel: i,
      inaltime: nr(s.inaltime) || nr(r.inaltime_nivel) || 1800,
      eticheta: s.eticheta || null,
      locuri: Math.max(1, nr(s.locuri_pe_camp) || nr(r.locuri_pe_camp) || 1),
      propriu: Boolean(nr(s.inaltime) || s.eticheta || nr(s.locuri_pe_camp)),
    });
  }
  return out;
}

// Înălțimea totală a rândului: nivelurile plus grinda de sub fiecare.
function inaltimeRand(niveluri) {
  return niveluri.reduce((s, n) => s + n.inaltime + GRINDA, 0);
}

// ---- Sectoare: porțiuni de rând cu alt număr de niveluri -------------------
// „Trebuie sa pot configura pe acelasi rand si 3 si 2 si 5 si 1 nivel pe
// orice interval adica nu sunt toate de 3." Un sector e un interval de
// câmpuri cu numărul lui de niveluri; un câmp care nu cade în niciun sector
// are câte niveluri are rândul.
const NIVEL_MAX = 12;
const PALETI_MAX = 6;

async function sectoareRand(randId) {
  let brut = [];
  try {
    brut = await db.prepare("SELECT * FROM ct_sectoare WHERE rand_id = ? ORDER BY camp_de_la, id").all(randId);
  } catch (e) {
    // Tabelul lipsește pe o bază veche: rândul e uniform, ca înainte.
    brut = [];
  }
  return (brut || [])
    .map((x) => ({
      id: Number(x.id),
      de_la: Math.max(1, Math.round(nr(x.camp_de_la))),
      pana_la: Math.max(1, Math.round(nr(x.camp_pana_la))),
      // Amândouă sunt opționale: un sector poate schimba doar înălțimea,
      // doar lățimea, sau pe amândouă. `null` înseamnă „lasă cum e rândul",
      // și e altceva decât 0 — de-aia nu se trece prin nr(), care face 0.
      niveluri: x.niveluri == null || x.niveluri === "" ? null : Math.max(1, Math.min(NIVEL_MAX, Math.round(nr(x.niveluri)))),
      locuri: x.locuri_pe_camp == null || x.locuri_pe_camp === "" ? null : Math.max(1, Math.min(PALETI_MAX, Math.round(nr(x.locuri_pe_camp)))),
    }))
    .filter((x) => x.pana_la >= x.de_la && (x.niveluri !== null || x.locuri !== null));
}

// Câte niveluri are fiecare câmp. Sectoarele se aplică în ordine, deci dacă
// două se suprapun câștigă ultimul — e singura regulă care se poate explica
// în hală fără diagramă, iar formularul le salvează oricum sortate.
function nivelurilePeCamp(r, sectoare, campuri) {
  const cate = Math.max(1, Math.round(nr(campuri) || nr(r.campuri)));
  const implicit = Math.max(1, Math.round(nr(r.niveluri)));
  const h = new Map();
  for (let c = 1; c <= cate; c++) h.set(c, implicit);
  for (const s of sectoare || []) {
    if (s.niveluri === null || s.niveluri === undefined) continue;
    for (let c = Math.max(1, s.de_la); c <= Math.min(cate, s.pana_la); c++) h.set(c, s.niveluri);
  }
  return h;
}

// Câți paleți intră în fiecare câmp. Deschiderea raftului nu e la fel peste
// tot: „acum ia 3 paleti peste tot trebuie sa pot pune si 2 si 1".
//
// Trei surse, în ordinea asta — de la cea mai precisă la cea mai generală:
//   1. sectorul câmpului, dacă are lățimea scrisă (bucata aia de raft);
//   2. nivelul, din ct_niveluri (jos paleți lați, sus cutii înguste);
//   3. cifra rândului.
// Sectorul bate nivelul fiindcă e despre un anumit raft montat într-un
// anumit loc, pe când nivelul e o regulă pentru tot rândul.
function paletiPeCamp(r, sectoare, campuri) {
  const cate = Math.max(1, Math.round(nr(campuri) || nr(r.campuri)));
  const h = new Map();
  for (const s of sectoare || []) {
    if (s.locuri === null || s.locuri === undefined) continue;
    for (let c = Math.max(1, s.de_la); c <= Math.min(cate, s.pana_la); c++) h.set(c, s.locuri);
  }
  return h;
}

// Aceeași regulă de precedență, pentru rutele care verifică o configurație
// VIITOARE și n-au de unde s-o ia din planRand. Stă aici ca să nu existe
// două socoteli care se pot despărți pe drum.
function locuriLaViitor(r, sectoare, campuri, locuriPeNivel) {
  const paleti = paletiPeCamp(r, sectoare, campuri);
  return (camp, nivel) => (paleti.has(camp) ? paleti.get(camp) : locuriPeNivel(nivel));
}

// Tot ce trebuie știut despre forma unui rând, într-un singur loc, ca să nu
// se citească sectoarele de trei ori pe pagină și să nu rămână vreun apelant
// cu socoteala veche (toate câmpurile la fel de înalte).
async function planRand(r, campuri) {
  const sectoare = await sectoareRand(r.id);
  const varf = Math.max(nr(r.niveluri), ...sectoare.map((s) => s.niveluri || 0), 1);
  const niveluri = await niveluriRand(r, varf);
  const peCamp = nivelurilePeCamp(r, sectoare, campuri);
  const paleti = paletiPeCamp(r, sectoare, campuri);

  // Câți paleți intră în căsuța (câmp, nivel). Singurul loc din cod care
  // răspunde la întrebarea asta — generarea locurilor, desenul și
  // verificarea „nu tăia raftul de sub marfă" o cheamă pe ea, ca să nu
  // ajungă vreodată să numere altfel una decât alta.
  const locuriLa = (camp, nivel) => {
    if (paleti.has(camp)) return paleti.get(camp);
    const n = niveluri[nivel - 1];
    return n ? n.locuri : Math.max(1, nr(r.locuri_pe_camp) || 1);
  };

  // Câte locuri ies din configurația asta: căsuță cu căsuță, pe nivelurile
  // care chiar există în câmpul ăla.
  let locuri = 0;
  for (const [camp, n] of peCamp) for (let i = 1; i <= n; i++) locuri += locuriLa(camp, i);
  return { sectoare, varf, niveluri, peCamp, paleti, locuriLa, locuri, uniform: sectoare.length === 0 };
}

// Bucățile de rând, citite din forma lui reală, nu din ce s-a scris în
// formular: câmpurile vecine cu același număr de niveluri se strâng la un
// loc. Așa se vede „1–4 cu 3 niveluri, 5–8 cu 5" chiar dacă sectoarele au
// fost scrise bucată cu bucată sau se suprapun.
function bucatiRand(peCamp, campuri, locuriLa) {
  const out = [];
  for (let c = 1; c <= campuri; c++) {
    const n = peCamp.get(c) || 0;
    // Lățimea bucății se citește de la nivelul 1, care există peste tot.
    const p = locuriLa ? locuriLa(c, 1) : null;
    const ultim = out[out.length - 1];
    if (ultim && ultim.niveluri === n && ultim.paleti === p) ultim.pana_la = c;
    else out.push({ de_la: c, pana_la: c, niveluri: n, paleti: p });
  }
  return out;
}

function rezumatSectoare(plan, campuri) {
  return bucatiRand(plan.peCamp, campuri, plan.locuriLa)
    .map((b) => {
      const cat = `<strong>${b.de_la === b.pana_la ? b.de_la : `${b.de_la}–${b.pana_la}`}</strong>`;
      const niv = `${b.niveluri} ${b.niveluri === 1 ? "nivel" : "niveluri"}`;
      const pal = b.paleti == null ? "" : ` × ${b.paleti} ${b.paleti === 1 ? "palet" : "paleți"}`;
      return `${cat} cu ${niv}${pal}`;
    })
    .join(", ");
}

// Locurile pe care stă marfă și care ar rămâne pe dinafară la o configurație
// nouă. Aceeași verificare se face și când se salvează rândul, și când se
// scoate un nivel — de-aia stă într-un singur loc.
// Locurile pe care stă marfă și care ar rămâne pe dinafară la o configurație
// nouă. Aceeași verificare se face peste tot unde se schimbă forma rândului.
//
// Amândouă limitele sunt FUNCȚII, nu numere, fiindcă rândul nu mai e uniform
// nici pe înălțime, nici pe lățime: „nivelul e prea sus" se judecă pe câmpul
// lui, iar „poziția e prea la dreapta" pe căsuța (câmp, nivel). Se acceptă
// și numere, pentru apelanții care chiar lucrează cu un rând uniform.
async function locuriInAfara(randId, campuri, niveluriLaCamp, locuriLa) {
  const cateNiveluri = typeof niveluriLaCamp === "function" ? niveluriLaCamp : () => nr(niveluriLaCamp);
  const catiPaleti = typeof locuriLa === "function" ? locuriLa : () => nr(locuriLa);
  const ocupate = await db
    .prepare(
      `SELECT l.adresa, l.nivel, l.camp, l.pozitie FROM ct_locuri l
         JOIN ct_ocupari o ON o.loc_id = l.id JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
        WHERE l.rand_id = ? ORDER BY l.nivel DESC, l.camp`
    )
    .all(randId);
  return ocupate.filter(
    (l) =>
      nr(l.camp) > campuri ||
      nr(l.nivel) > (cateNiveluri(nr(l.camp)) || 0) ||
      nr(l.pozitie) > (catiPaleti(nr(l.camp), nr(l.nivel)) || 0)
  );
}

async function sumarRanduri() {
  const randuri = await db.prepare("SELECT * FROM ct_randuri WHERE activ = 1 ORDER BY numar").all();
  if (!randuri.length) return [];
  // Câte locuri are rândul și câte sunt sub o paletă care încă e în depozit.
  // Două interogări separate fiindcă una singură ar trebui să numere și
  // rândurile fără nicio ocupare, iar un LEFT JOIN cu condiție pe tabelul din
  // dreapta se citește mai greu decât două numărători scurte.
  const numarLocuri = await db.prepare("SELECT rand_id, COUNT(*) AS n FROM ct_locuri GROUP BY rand_id").all();
  const hl = new Map(numarLocuri.map((o) => [Number(o.rand_id), nr(o.n)]));
  const ocupate = await db
    .prepare(
      `SELECT l.rand_id, COUNT(DISTINCT l.id) AS n
         FROM ct_locuri l
         JOIN ct_ocupari o ON o.loc_id = l.id
         JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
        GROUP BY l.rand_id`
    )
    .all();
  const ho = new Map(ocupate.map((o) => [Number(o.rand_id), nr(o.n)]));
  return randuri.map((r) => ({
    ...r,
    locuri: hl.get(Number(r.id)) || 0,
    ocupate: ho.get(Number(r.id)) || 0,
  }));
}

function register(router) {
  // Planul halei se citește o dată, la pornire. Dacă baza nu răspunde încă,
  // rămân cifrele din planul de montaj și se reîncarcă la prima salvare.
  incarcaPlan().catch(() => {});

  router.get("/stocuri/ct-park/sectiune", paginaSectiune);

  // ---- Harta: rândurile, cu gradul de umplere ----------------------------
  router.get("/stocuri/ct-park", async (ctx) => {
    const randuri = await sumarRanduri();
    const totalLocuri = randuri.reduce((s, r) => s + r.locuri, 0);
    const totalOcupate = randuri.reduce((s, r) => s + r.ocupate, 0);
    const paleti = nr((await db.prepare("SELECT COUNT(*) AS n FROM ct_paleti WHERE data_iesire IS NULL").get()).n);
    const libere = Math.max(0, totalLocuri - totalOcupate);
    const gradOcupare = totalLocuri ? (totalOcupate / totalLocuri) * 100 : 0;

    // Valoarea mărfii, la prețul cu care a intrat. Paleții fără preț se
    // numără separat: e mai cinstit să spui „lipsesc N paleți din sumă" decât
    // să dai o cifră care pare întreagă și nu e.
    const v = await db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(cantitate, 0) * COALESCE(pret_unitar, 0)), 0) AS valoare,
                COUNT(*) FILTER (WHERE pret_unitar IS NULL OR pret_unitar = 0) AS fara_pret
           FROM ct_paleti WHERE data_iesire IS NULL`
      )
      .get()
      .catch(() => null);
    const valoare = nr(v && v.valoare);
    const faraPret = nr(v && v.fara_pret);

    if (!randuri.length) {
      const body = `
        ${subtabs("/stocuri/ct-park")}
        <div class="detail-box" style="border-left:4px solid var(--danger);max-width:760px">
          <h2 style="margin-top:0">Depozitul nu e încă împărțit pe locuri de palet</h2>
          <p>Ca să poți pune marfă pe adrese, ERP-ul trebuie să știe câte câmpuri și câte niveluri are fiecare rând.
             Se face o singură dată, din <a href="/stocuri/ct-park/configurare">Configurare rânduri</a> —
             sunt deja pregătite cele ${GRUPURI.flat().length} rânduri din planul de montaj, trebuie doar spus
             câte niveluri și câte câmpuri au.</p>
          <a class="btn" href="/stocuri/ct-park/configurare">Configurează rândurile</a>
          ${ARATA_SECTIUNEA_TEHNICA ? `<a class="btn secondary" href="/stocuri/ct-park/sectiune">Vezi secțiunea tehnică</a>` : ""}
        </div>`;
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Depozit CT-Park", active: "/stocuri/ct-park", body }));
    }

    const body = `
      ${subtabs("/stocuri/ct-park")}
      <div class="toolbar">
        <a class="btn" href="/stocuri/ct-park/intrare">+ Intrare marfă</a>
        <a class="btn secondary" href="/stocuri/ct-park/paleti">Paleți în depozit</a>
      </div>
      <div class="cards">
        <div class="card"><div class="label">Paleți reali în stoc</div><div class="value">${paleti}</div>
          <div class="ct-sub">ocupă ${plural(totalOcupate, "loc", "locuri")}${paleti ? ` · ${(totalOcupate / paleti).toFixed(2)} locuri/palet` : ""}</div></div>
        <div class="card"><div class="label">Grad de ocupare</div><div class="value">${procent(gradOcupare)}</div>
          <div class="ct-sub">${totalOcupate} din ${totalLocuri} locuri — se numără locurile, nu paleții</div></div>
        <div class="card"><div class="label">Spații libere</div><div class="value">${libere}</div>
          <div class="ct-sub">locuri de palet, în ${plural(randuri.length, "rând", "rânduri")}</div></div>
        <div class="card"><div class="label">Valoarea mărfii</div><div class="value">${lei(valoare)}</div>
          <div class="ct-sub">la preț de intrare${faraPret ? ` · <strong>${plural(faraPret, "palet fără preț", "paleți fără preț")}</strong>, nu intră în sumă` : ""}</div></div>
      </div>
      ${
        faraPret
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:820px;margin-bottom:12px">
              <strong>${plural(faraPret, "palet a intrat", "paleți au intrat")} fără preț</strong>, deci valoarea de mai sus e incompletă.
              Prețul se scrie la recepție, pe formularul de intrare — iar pentru cei deja intrați se poate completa
              din <a href="/stocuri/ct-park/paleti">lista de paleți</a>, pe fiecare palet.
            </div>`
          : ""
      }

      <p style="font-size:13px;color:var(--text-muted);max-width:820px">
        Click pe un rând ca să-i vezi fața: câmpurile pe orizontală, nivelurile pe verticală, câte trei locuri de palet
        în fiecare câmp. Cifra din bară e cât e ocupat din rând.
      </p>

      <div class="ct-randuri">
        ${randuri
          .map((r) => {
            const p = r.locuri ? Math.round((r.ocupate / r.locuri) * 100) : 0;
            const culoare = p > 90 ? "#c0392b" : p > 70 ? "#c07018" : "#2f7d4f";
            return `<a class="ct-rand-card" href="/stocuri/ct-park/rand/${r.id}">
              <div class="ct-rand-nr">Rândul ${r.numar}</div>
              <div style="margin:4px 0 8px">${pastila(r.eticheta) || '<span style="font-size:11px;color:var(--text-muted)">fără categorie</span>'}</div>
              <div class="ct-bara"><span style="width:${p}%;background:${culoare}"></span></div>
              <div class="ct-rand-cifre">${r.ocupate} / ${r.locuri} locuri · ${p}%</div>
              <div style="font-size:11px;color:var(--text-muted)">${r.campuri} câmpuri × ${plural(r.niveluri, "nivel", "niveluri")}</div>
            </a>`;
          })
          .join("")}
      </div>

      <style>
        .ct-randuri { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin-top:8px; }
        .ct-rand-card { display:block; border:1px solid var(--border); border-radius:8px; padding:12px 14px; text-decoration:none; color:inherit; background:#fff; }
        .ct-rand-card:hover { border-color:var(--primary); box-shadow:0 1px 6px rgba(0,0,0,.06); }
        .ct-rand-nr { font-weight:700; font-size:15px; }
        .ct-bara { height:8px; border-radius:4px; background:#eceff3; overflow:hidden; }
        .ct-bara span { display:block; height:100%; }
        .ct-rand-cifre { font-size:12px; margin-top:5px; }
      </style>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Depozit CT-Park", active: "/stocuri/ct-park", body }));
  });

  // ---- Planul halei ------------------------------------------------------
  // Câte rânduri are hala, care stau spate în spate, cât de late sunt
  // culoarele. De aici se nasc și rândurile create „din planul de montaj",
  // și desenul secțiunii. Nu atinge locurile deja configurate: un rând scos
  // din plan rămâne în depozit până îl scoți tu din „Configurare rânduri".
  router.get("/stocuri/ct-park/plan", async (ctx) => {
    await incarcaPlan();
    const p = planCurent();
    const poz = pozitii();
    const latime = poz.length ? poz[poz.length - 1].x + ADANCIME : 0;
    const configurate = new Set(
      (await db.prepare("SELECT numar FROM ct_randuri").all().catch(() => [])).map((r) => nr(r.numar))
    );
    const inPlan = p.grupuri.flat();
    const lipsa = inPlan.filter((n) => !configurate.has(n));
    const inPlus = [...configurate].filter((n) => !inPlan.includes(n)).sort((a, b) => a - b);

    const body = `
      ${subtabs("/stocuri/ct-park/plan")}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Planul halei</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:880px">
        Aici se desenează hala, nu raftul: câte rânduri sunt, care stau lipite spate în spate și cât de late
        sunt culoarele dintre ele. Până acum cifrele astea erau scrise în cod — acum se schimbă de aici.
        <strong>Un grup pe linie</strong>, numerele rândurilor despărțite prin spațiu. O linie cu două numere
        înseamnă două rânduri spate în spate, iar între linii rămâne un culoar.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Rânduri în plan</div><div class="value">${inPlan.length}</div>
          <div class="ct-sub">în ${plural(p.grupuri.length, "grup", "grupuri")}</div></div>
        <div class="card"><div class="label">Culoare de lucru</div><div class="value">${Math.max(0, p.grupuri.length - 1)}</div>
          <div class="ct-sub">câte ${(p.culoar / 1000).toFixed(2)} m</div></div>
        <div class="card"><div class="label">Lățime ocupată</div><div class="value">${(latime / 1000).toFixed(2)} m</div>
          <div class="ct-sub">de la primul la ultimul raft</div></div>
        <div class="card"><div class="label">Adâncime raft</div><div class="value">${(p.adancime / 1000).toFixed(2)} m</div>
          <div class="ct-sub">un rând, văzut în secțiune</div></div>
      </div>

      <form class="form" method="post" action="/stocuri/ct-park/plan" style="max-width:900px">
        <label class="field">Grupurile de rânduri, de la stânga la dreapta
          <textarea name="grupuri" rows="${Math.max(5, p.grupuri.length + 1)}" style="font-family:ui-monospace,monospace;font-size:14px;line-height:1.7">${esc(grupuriCaText(p.grupuri))}</textarea>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;max-width:640px">
          <label class="field">Adâncime raft (mm)<input type="number" name="adancime" min="200" max="4000" value="${p.adancime}" required></label>
          <label class="field">Joc spate în spate (mm)<input type="number" name="spate" min="0" max="2000" value="${p.spate}" required></label>
          <label class="field">Culoar de lucru (mm)<input type="number" name="culoar" min="500" max="20000" value="${p.culoar}" required></label>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Salvează planul</button>
          <button class="btn secondary" type="submit" name="implicit" value="1">Înapoi la planul de montaj</button>
        </div>
      </form>

      <h2 style="margin-top:22px">Așezarea rezultată</h2>
      <div class="tabel-scroll">${table(
        ["Grup", "Rânduri", "Fel", "De la (m)", "Până la (m)"],
        p.grupuri.map((g, i) => {
          const ale = poz.filter((r) => r.grup === i);
          return [
            String(i + 1),
            g.join(" · "),
            g.length > 1 ? "spate în spate" : "rând simplu",
            ale.length ? (ale[0].x / 1000).toFixed(2) : "—",
            ale.length ? ((ale[ale.length - 1].x + ADANCIME) / 1000).toFixed(2) : "—",
          ];
        })
      )}</div>

      ${
        lipsa.length || inPlus.length
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:880px;margin-top:14px">
              ${lipsa.length ? `<div><strong>În plan, dar neconfigurate:</strong> rândurile ${lipsa.join(", ")}. Le creezi din <a href="/stocuri/ct-park/configurare">Configurare rânduri</a>.</div>` : ""}
              ${inPlus.length ? `<div style="margin-top:6px"><strong>Configurate, dar nu mai sunt în plan:</strong> rândurile ${inPlus.join(", ")}. Rămân în depozit cu marfa pe ele — planul nu le șterge, tu decizi.</div>` : ""}
            </div>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Planul halei · CT-Park", active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/plan", async (ctx) => {
    const b = ctx.body || {};
    if (String(b.implicit || "") === "1") {
      await salveazaPlan(PLAN_IMPLICIT);
      return redirect(ctx.res, `/stocuri/ct-park/plan?ok=${encodeURIComponent("S-a revenit la planul de montaj.")}`);
    }
    const grupuri = grupuriDinText(b.grupuri);
    if (!grupuri.length) {
      return redirect(
        ctx.res,
        `/stocuri/ct-park/plan?eroare=${encodeURIComponent("Planul n-are niciun rând. Scrie măcar o linie cu un număr de rând.")}`
      );
    }
    const toate = grupuri.flat();
    const duplicate = toate.filter((n, i) => toate.indexOf(n) !== i);
    if (duplicate.length) {
      return redirect(
        ctx.res,
        `/stocuri/ct-park/plan?eroare=${encodeURIComponent("Rândul " + [...new Set(duplicate)].join(", ") + " apare de două ori în plan. Un rând stă într-un singur loc în hală.")}`
      );
    }
    await salveazaPlan({ grupuri, adancime: b.adancime, spate: b.spate, culoar: b.culoar });
    redirect(
      ctx.res,
      `/stocuri/ct-park/plan?ok=${encodeURIComponent(toate.length + " rânduri în " + grupuri.length + " grupuri. Planul a fost salvat.")}`
    );
  });

  // ---- Stoc la zi --------------------------------------------------------
  // Ce e ACUM în depozit, grupat pe categorii, cu de unde a venit, când a
  // intrat și pe ce raft stă. E lista pe care o ceri când sună cineva și
  // întreabă „mai avem din aia?" — de-aia are căutare, și de-aia caută în tot
  // (produs, cod, lot, furnizor, adresă), nu doar în denumire.
  router.get("/stocuri/ct-park/stoc", async (ctx) => {
    const cauta = String((ctx.query && ctx.query.q) || "").trim();

    // Paleții din depozit. Locurile se aduc separat și se lipesc în JS: o
    // paletă lată stă pe două-trei locuri, iar un JOIN ar multiplica rândul
    // și ar strica totalurile de cantitate și valoare.
    // Furnizorul scris pe paletă există doar după ce a rulat migrarea. Până
    // atunci pagina merge oricum, cu furnizorul dedus din facturi.
    const cuFurnizor = await areColoana("ct_paleti", "furnizor_id");
    const paleti = await db
      .prepare(
        `SELECT p.id, p.cod, p.produs_id, p.produs_text, p.cantitate, p.um, p.lot, p.categorie,
                p.data_intrare, p.pret_unitar, p.pret_sursa,
                ${cuFurnizor ? "p.furnizor_id, p.furnizor_text, f.nume AS furnizor_nume" : "NULL AS furnizor_id, NULL AS furnizor_text, NULL AS furnizor_nume"},
                pr.denumire AS produs, pr.cod AS produs_cod, pr.unitate_masura
           FROM ct_paleti p
           LEFT JOIN produse pr ON pr.id = p.produs_id
           ${cuFurnizor ? "LEFT JOIN parteneri f ON f.id = p.furnizor_id" : ""}
          WHERE p.data_iesire IS NULL
          ORDER BY p.data_intrare DESC, p.id DESC`
      )
      .all();

    const locuri = await db
      .prepare(
        `SELECT o.palet_id, l.adresa, l.nivel, l.camp, l.pozitie, r.numar AS rand
           FROM ct_ocupari o
           JOIN ct_locuri l ON l.id = o.loc_id
           JOIN ct_randuri r ON r.id = l.rand_id
          ORDER BY r.numar, l.nivel, l.camp, l.pozitie`
      )
      .all();
    const peP = new Map();
    for (const l of locuri) {
      const k = Number(l.palet_id);
      if (!peP.has(k)) peP.set(k, []);
      peP.get(k).push(l);
    }

    // Furnizorul, când nu e scris pe paletă. Se ia din ultima factură de
    // ACHIZIȚIE în care apare produsul — e o deducție, nu un fapt, de-aia se
    // arată cu gri și cu „(dedus)". Ce se scrie la recepție bate deducția.
    const idProduse = [...new Set(paleti.map((p) => nr(p.produs_id)).filter(Boolean))];
    const dedus = new Map();
    if (idProduse.length) {
      const semne = idProduse.map(() => "?").join(", ");
      const randuri = await db
        .prepare(
          `SELECT fl.produs_id, pa.nume, f.data_emiterii
             FROM facturi_linii fl
             JOIN facturi f ON f.id = fl.factura_id AND f.directie = 'achizitie'
             JOIN parteneri pa ON pa.id = f.partener_id
            WHERE fl.produs_id IN (${semne})
            ORDER BY f.data_emiterii`
        )
        .all(...idProduse)
        .catch(() => []);
      // Ordonate crescător, deci ultima scriere câștigă: rămâne cea mai recentă.
      for (const r of randuri || []) dedus.set(nr(r.produs_id), r.nume);
    }

    const randuriStoc = paleti.map((p) => {
      const ls = peP.get(Number(p.id)) || [];
      const furnizor = p.furnizor_nume || p.furnizor_text || null;
      const furnizorDedus = furnizor ? null : dedus.get(nr(p.produs_id)) || null;
      return {
        ...p,
        marfa: p.produs || p.produs_text || "(fără denumire)",
        cod: p.produs_cod || p.cod || "",
        um: p.um || p.unitate_masura || "",
        adrese: ls.map((l) => l.adresa),
        rand: ls.length ? ls[0].rand : null,
        nivel: ls.length ? ls[0].nivel : null,
        camp: ls.length ? ls[0].camp : null,
        furnizor,
        furnizorDedus,
        valoare: nr(p.cantitate) * nr(p.pret_unitar),
      };
    });

    const potrivit = (r) => {
      if (!cauta) return true;
      const t = cauta.toLowerCase();
      return [r.marfa, r.cod, r.lot, r.categorie, r.furnizor, r.furnizorDedus, r.um, r.data_intrare]
        .concat(r.adrese)
        .some((x) => String(x || "").toLowerCase().includes(t));
    };
    const vizibile = randuriStoc.filter(potrivit);

    // Grupate pe categorie, în ordinea din nomenclator, cu „fără categorie" la
    // final — nu în mijloc, unde s-ar pierde.
    const ordine = CATEGORII.concat(["(fără categorie)"]);
    const grupe = new Map(ordine.map((c) => [c, []]));
    for (const r of vizibile) {
      const c = CATEGORII.includes(String(r.categorie)) ? String(r.categorie) : "(fără categorie)";
      grupe.get(c).push(r);
    }

    const valoareTotala = vizibile.reduce((s, r) => s + r.valoare, 0);
    const faraPret = vizibile.filter((r) => !nr(r.pret_unitar)).length;
    const locuriOcupate = vizibile.reduce((s, r) => s + r.adrese.length, 0);

    const cap = ["Marfă", "Cod", "Lot", "Cantitate", "Furnizor", "Intrat în stoc", "Unde stă", "Valoare"];
    const randCatre = (r) => [
      `<strong>${esc(r.marfa)}</strong>`,
      esc(r.cod || "—"),
      esc(r.lot || "—"),
      `${nr(r.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })} ${esc(r.um)}`,
      r.furnizor
        ? esc(r.furnizor)
        : r.furnizorDedus
          ? `<span style="color:var(--text-muted)">${esc(r.furnizorDedus)} <span style="font-size:11px">(dedus)</span></span>`
          : '<span style="color:var(--text-muted)">—</span>',
      esc(String(r.data_intrare || "").slice(0, 10)),
      r.adrese.length
        ? `<span title="${esc(r.adrese.join(", "))}">${esc(r.adrese[0])}${r.adrese.length > 1 ? ` <span style="font-size:11px;color:var(--text-muted)">+${r.adrese.length - 1}</span>` : ""}</span>
           <div style="font-size:11px;color:var(--text-muted)">rând ${esc(String(r.rand))} · câmp ${esc(String(r.camp))} · nivel ${esc(String(r.nivel))}</div>`
        : '<span style="color:var(--danger,#b91c1c)">nicăieri — paletă fără loc</span>',
      nr(r.pret_unitar)
        ? `${r.valoare.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei
           <div style="font-size:11px;color:var(--text-muted)">${nr(r.pret_unitar).toLocaleString("ro-RO", { maximumFractionDigits: 4 })} / ${esc(r.um || "UM")}</div>`
        : '<span style="color:var(--text-muted)">fără preț</span>',
    ];

    const sectiuni = ordine
      .filter((c) => grupe.get(c).length)
      .map((c) => {
        const lista = grupe.get(c);
        const val = lista.reduce((s, r) => s + r.valoare, 0);
        const total = [
          `<strong>${plural(lista.length, "palet", "paleți")}</strong>`,
          "",
          "",
          "",
          "",
          "",
          `<strong>${plural(lista.reduce((s, r) => s + r.adrese.length, 0), "loc", "locuri")}</strong>`,
          `<strong>${val.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei</strong>`,
        ];
        return `<h2 style="margin:22px 0 6px">${esc(c)} <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— ${plural(lista.length, "palet", "paleți")}</span></h2>
          <div class="tabel-scroll">${table(cap, lista.map(randCatre), { total })}</div>`;
      })
      .join("");

    const body = `
      ${subtabs("/stocuri/ct-park/stoc")}
      <h1 style="margin:6px 0 2px">Stoc la zi</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
        Tot ce e acum în depozit, grupat pe categorii. Pentru fiecare paletă: de la cine a venit, când a intrat
        și pe ce raft stă. Căutarea merge în denumire, cod, lot, furnizor, categorie și adresă — deci poți căuta
        și „R3-05" ca să vezi ce e pe un anume loc.
      </p>

      ${
        cuFurnizor
          ? ""
          : `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:880px">
              Baza de date n-a primit încă migrarea pentru furnizorul scris pe paletă, deci toți furnizorii de mai jos
              sunt <strong>deduși din facturile de achiziție</strong>. Se rezolvă singur la următoarea pornire a aplicației,
              după ce ajunge pe server versiunea nouă a fișierului <code>lib/db.js</code>.
            </div>`
      }

      <form method="get" action="/stocuri/ct-park/stoc" class="toolbar">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="caută marfă, lot, furnizor, adresă…" style="min-width:320px">
        <button class="btn" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary" href="/stocuri/ct-park/stoc">Vezi tot</a>` : ""}
        <a class="btn secondary" href="/stocuri/ct-park/intrare">+ Intrare marfă</a>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Paleți${cauta ? " găsiți" : " în depozit"}</div><div class="value">${vizibile.length}</div>
          <div class="ct-sub">${cauta ? `din ${randuriStoc.length} în total` : "paleți reali, nu locuri"}</div></div>
        <div class="card"><div class="label">Locuri ocupate</div><div class="value">${locuriOcupate}</div>
          <div class="ct-sub">${vizibile.length ? (locuriOcupate / vizibile.length).toFixed(2) : "0"} locuri/palet · un palet lat stă pe 2–3</div></div>
        <div class="card"><div class="label">Valoare la preț de intrare</div><div class="value">${lei(valoareTotala)}</div>
          <div class="ct-sub">${faraPret ? `<strong>${plural(faraPret, "palet fără preț", "paleți fără preț")}</strong>, nu intră în sumă` : "toți paleții au preț"}</div></div>
      </div>

      ${vizibile.length ? sectiuni : `<p style="margin-top:18px">${cauta ? "Nimic nu se potrivește cu „" + esc(cauta) + "”." : "Depozitul e gol."}</p>`}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Stoc la zi · CT-Park", active: "/stocuri/ct-park", body }));
  });

  // ---- Fața unui rând ----------------------------------------------------
  router.get("/stocuri/ct-park/rand/:id", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/stocuri/ct-park", body: "<p>Rândul nu există.</p>" }));
    const locuri = await locuriRand(r.id);
    const plan = await planRand(r);
    const niveluri = plan.niveluri;
    const peCamp = plan.peCamp;

    // Cheia „nivel|camp|pozitie" ca să pot desena grila fără să caut în listă.
    const h = new Map();
    for (const l of locuri) h.set(`${l.nivel}|${l.camp}|${l.pozitie}`, l);

    const paletiRand = new Map();
    for (const l of locuri) if (l.palet_id) paletiRand.set(Number(l.palet_id), l);

    const ocupate = locuri.filter((l) => l.palet_id).length;
    const latimeCamp = nr(r.latime_loc) * nr(r.locuri_pe_camp);

    // Desenul e la scară pe verticală: un nivel de 2,2 m se vede mai înalt
    // decât unul de 1,2 m. Altfel „designul de stocare" arată la fel oricum
    // l-ai configura, și nu se vede ce-ai făcut.
    const PX_PE_MM = 0.024;
    const inaltimePx = (mm) => Math.max(26, Math.min(120, Math.round(nr(mm) * PX_PE_MM)));

    let grila = "";
    for (let i = niveluri.length - 1; i >= 0; i--) {
      const n = niveluri[i];
      const nivel = n.nivel;
      const hPx = inaltimePx(n.inaltime);
      let celule = "";
      for (let camp = 1; camp <= nr(r.campuri); camp++) {
        // Câmpul ăsta nu urcă până aici: rândul e mai scund pe porțiunea lui.
        // Desenăm un gol de aceeași lățime, ca să nu se decaleze grila și ca
        // să se vadă silueta adevărată a raftului, nu una dreaptă inventată.
        if (nivel > (peCamp.get(camp) || 0)) {
          const goluri = new Array(plan.locuriLa(camp, nivel))
            .fill(`<div class="ct-loc fara-raft" style="height:${hPx}px"></div>`)
            .join("");
          celule += `<div class="ct-camp gol" data-nivel="${nivel}" data-camp="${camp}" title="Câmpul ${camp} are ${peCamp.get(camp) || 0} niveluri — aici nu e raft">
              <div class="ct-camp-locuri">${goluri}</div>
              <div class="ct-camp-eticheta">&nbsp;</div>
            </div>`;
          continue;
        }
        let pozitii = "";
        // Câți paleți intră AICI, nu pe nivel în general: un câmp dintr-un
        // sector de 2 paleți are două căsuțe, nu trei. Cum .ct-camp e
        // flex:1 și .ct-loc la fel, cele două ies mai late în aceeași
        // deschidere — adică exact ce se vede în hală.
        for (let poz = 1; poz <= plan.locuriLa(camp, nivel); poz++) {
          const l = h.get(`${nivel}|${camp}|${poz}`);
          if (!l) {
            pozitii += `<div class="ct-loc lipsa" style="height:${hPx}px"></div>`;
            continue;
          }
          const ocupat = !!l.palet_id;
          const culoare = ocupat ? CULORI_CATEGORII[l.palet_categorie || l.categorie] || "#5a6472" : null;
          const titlu = ocupat
            ? `${l.adresa} · ${l.produs || l.produs_text || "marfă"} · ${nr(l.cantitate) || "?"} ${l.um || ""} · intrat ${l.data_intrare}`
            : `${l.adresa} · liber${l.categorie ? " · zonă " + l.categorie : ""}`;
          // Locul OCUPAT ramane link catre paleta lui. Locul LIBER era un div
          // mort: se vedea ca e liber si atat. Acum e o casuta bifabila —
          // arati cu degetul unde vrei marfa, exact ca in hala, in loc sa
          // speri ca propunerea automata nimereste raftul la care te gandeai.
          // `data-loc` e pentru modul de editare: acolo un click pe loc nu-l
          // mai alege pentru marfă, ci îl scoate din uz sau îl repune.
          if (ocupat) {
            pozitii += `<a href="/stocuri/ct-park/palet/${l.palet_id}" class="ct-loc ocupat${nr(l.blocat) ? " blocat" : ""}"
                title="${esc(titlu)}" data-adresa="${esc(l.adresa)}" data-loc="${l.id}" data-ocupat="1"
                style="height:${hPx}px;background:${culoare}1f;border-color:${culoare}66">
                <span class="ct-loc-adresa">${esc(String(l.pozitie))}</span>
                <span class="ct-loc-marfa">${esc(String(l.produs || l.produs_text || "").slice(0, 22))}</span>
              </a>`;
          } else if (nr(l.blocat)) {
            pozitii += `<div class="ct-loc liber blocat" title="${esc(titlu)} · scos din uz" data-adresa="${esc(l.adresa)}"
                data-loc="${l.id}" data-blocat="1" style="height:${hPx}px">
                <span class="ct-loc-adresa">${esc(String(l.pozitie))}</span></div>`;
          } else {
            pozitii += `<label class="ct-loc liber alegibil" title="${esc(titlu)}" data-adresa="${esc(l.adresa)}"
                data-loc="${l.id}" style="height:${hPx}px">
                <input type="checkbox" name="loc" value="${l.id}" data-adresa="${esc(l.adresa)}"
                       data-nivel="${nivel}" data-camp="${camp}" data-pozitie="${l.pozitie}">
                <span class="ct-loc-adresa">${esc(String(l.pozitie))}</span>
              </label>`;
          }
        }
        const zona = h.get(`${nivel}|${camp}|1`);
        celule += `<div class="ct-camp" data-nivel="${nivel}" data-camp="${camp}">
            <div class="ct-camp-locuri">${pozitii}</div>
            <div class="ct-camp-eticheta">${camp}${zona && zona.categorie ? ` · ${esc(zona.categorie)}` : ""}</div>
          </div>`;
      }
      grila += `<div class="ct-nivel">
          <div class="ct-nivel-eticheta" title="${esc(n.eticheta || "")}">
            <span>N${nivel}</span>
            <span class="ct-nivel-mm">${(n.inaltime / 1000).toFixed(2)} m</span>
            <span class="ct-nivel-mm">${n.locuri} pal.</span>
          </div>
          <div class="ct-nivel-campuri">${celule}</div>
        </div>`;
    }

    const body = `
      ${subtabs("/stocuri/ct-park")}
      <div class="toolbar">
        <a class="btn secondary" href="/stocuri/ct-park">← Harta depozitului</a>
        <a class="btn" href="/stocuri/ct-park/intrare?rand=${r.id}">+ Intrare marfă în rândul ăsta</a>
      </div>
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Rândul ${r.numar} ${pastila(r.eticheta)}</h1>
      <p style="margin:0 0 6px;color:var(--text-muted);font-size:13px">
        ${
          plan.uniform
            ? `${r.campuri} câmpuri × ${niveluri.length} niveluri = <strong>${locuri.length} locuri</strong>`
            : `${r.campuri} câmpuri, <strong>${locuri.length} locuri</strong> — rândul nu e la fel peste tot:
               ${rezumatSectoare(plan, nr(r.campuri))}`
        }, din care
        <strong>${ocupate} ocupate</strong>. Înălțimea rândului: <strong>${(inaltimeRand(niveluri) / 1000).toFixed(2)} m</strong>
        la cel mai înalt punct.
        Un loc de palet: ${nr(r.latime_loc)} × ${nr(r.adancime_loc)} mm, un câmp are ${(latimeCamp / 1000).toFixed(2)} m deschidere.
        ${niveluri.some((n) => n.propriu) ? "Nivelurile nu sunt toate la fel — vezi cotele din stânga desenului." : ""}
      </p>
      <div class="ct-niv-butoane" style="margin-bottom:10px">
        ${butoaneNivel(r, "rand")}
        <span style="font-size:12px;color:var(--text-muted)">niveluri — adaugă unul deasupra sau scoate-l pe cel de sus</span>
        <a class="btn small secondary" href="/stocuri/ct-park/configurare/${r.id}">Înălțimi și paleți pe nivel</a>
        <button class="btn small" type="button" id="buton-editez">Editez raftul</button>
      </div>
      <div id="panou-editare" hidden style="margin:0 0 10px;padding:10px 12px;border:1px solid var(--accent,#2f6fde);border-radius:8px;background:rgba(47,111,222,.05)">
        <div style="font-size:13px;margin-bottom:6px">
          <strong>Editezi raftul.</strong> Sub fiecare câmp ai câte niveluri și câți paleți are —
          apeși − sau + și <strong>se salvează pe loc</strong>. Click pe un loc îl scoate din uz
          (sau îl repune). Bifează numerele câmpurilor ca să schimbi mai multe deodată.
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px">
          <button class="btn small secondary" type="button" data-rand-camp="adauga">+ încă un câmp</button>
          <button class="btn small secondary" type="button" data-rand-camp="scoate">− ultimul câmp</button>
          <span id="editare-stare" style="color:var(--text-muted)"></span>
        </div>
        <div id="editare-interval" hidden style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:13px">
          <span id="editare-interval-text"></span>
          <label style="margin-left:10px">niveluri <input class="ct-in" style="width:64px" type="number" min="1" max="${NIVEL_MAX}" id="interval-niveluri" placeholder="—"></label>
          <label style="margin-left:6px">paleți <input class="ct-in" style="width:64px" type="number" min="1" max="${PALETI_MAX}" id="interval-paleti" placeholder="—"></label>
          <button class="btn small" type="button" id="interval-aplica" style="margin-left:6px">Aplică</button>
          <a href="#" id="interval-renunt" style="margin-left:8px;font-size:12px">renunț</a>
        </div>
      </div>

      <form method="get" action="/stocuri/ct-park/intrare" id="forma-locuri">
        <input type="hidden" name="rand" value="${r.id}">
        ${/* Casutele se cheama „loc" si sunt mai multe. Adresa iese
             „loc=1&loc=2&loc=3", iar parserul de query al aplicatiei face
             Object.fromEntries(searchParams.entries()) — care pastreaza
             DOAR ULTIMA valoare. Adica din trei locuri alese ajungea unul,
             si ala citit sub alt nume. De-aia exista campul ascuns de mai
             jos: JS-ul lipeste id-urile cu virgula intr-o singura valoare,
             care trece intreaga prin parser. */ ""}
        <input type="hidden" name="locuri" id="locuri-lipite" value="">
        <div class="ct-fata">
          <div class="ct-grila">${grila}</div>
          ${/* Banda de comenzi pe câmp. Are aceeași structură ca un nivel —
               etichetă în stânga, câmpurile în dreapta — ca să se alinieze
               exact sub coloanele desenului, fără calcule de pixeli. */ ""}
          <div class="ct-nivel ct-banda-editare" hidden>
            <div class="ct-nivel-eticheta"><span style="font-size:11px">pe câmp</span></div>
            <div class="ct-nivel-campuri">
              ${Array.from({ length: nr(r.campuri) }, (_, i) => i + 1)
                .map(
                  (camp) => `<div class="ct-camp ct-camp-editare">
                    <label class="ct-camp-bifa"><input type="checkbox" class="bifa-camp" value="${camp}"> ${camp}</label>
                    <div class="ct-camp-rand"><button type="button" class="ct-mic" data-camp="${camp}" data-ce="niveluri" data-pas="-1">−</button>
                      <span class="ct-camp-cifra" data-camp="${camp}" data-ce="niveluri">${peCamp.get(camp) || 0}</span>
                      <button type="button" class="ct-mic" data-camp="${camp}" data-ce="niveluri" data-pas="1">+</button>
                      <span class="ct-camp-um">niv</span></div>
                    <div class="ct-camp-rand"><button type="button" class="ct-mic" data-camp="${camp}" data-ce="paleti" data-pas="-1">−</button>
                      <span class="ct-camp-cifra" data-camp="${camp}" data-ce="paleti">${plan.locuriLa(camp, 1)}</span>
                      <button type="button" class="ct-mic" data-camp="${camp}" data-ce="paleti" data-pas="1">+</button>
                      <span class="ct-camp-um">pal</span></div>
                  </div>`
                )
                .join("")}
            </div>
          </div>
          <div class="ct-podea">pardoseală</div>
        </div>
        <div class="bara-selectie" id="bara-locuri" hidden>
          <span id="bara-locuri-text"></span>
          <button class="btn small" type="submit" style="margin-left:8px">Pune marfă pe locurile astea</button>
          <a href="#" id="bara-locuri-renunt" style="margin-left:10px;font-size:12px">renunț</a>
        </div>
      </form>
      <script>
        (function () {
          var f = document.getElementById("forma-locuri");
          var bara = document.getElementById("bara-locuri");
          var txt = document.getElementById("bara-locuri-text");
          function alese() {
            return Array.prototype.filter.call(f.querySelectorAll('input[name="loc"]'), function (b) { return b.checked; });
          }
          var lipite_camp = document.getElementById("locuri-lipite");
          f.addEventListener("change", function () {
            var a = alese();
            // Valoarea care chiar ajunge la server.
            lipite_camp.value = a.map(function (b) { return b.value; }).join(",");
            bara.hidden = a.length === 0;
            if (!a.length) return;
            var adrese = a.map(function (b) { return b.dataset.adresa; });
            // Spune pe loc daca sunt lipite sau nu: o paleta lata are nevoie
            // de pozitii vecine in acelasi camp si nivel, iar omul trebuie sa
            // afle asta cand da click, nu la pasul urmator.
            var lipite = true;
            if (a.length > 1) {
              var n = a[0].dataset.nivel, c = a[0].dataset.camp;
              var poz = a.map(function (b) { return Number(b.dataset.pozitie); }).sort(function (x, y) { return x - y; });
              lipite = a.every(function (b) { return b.dataset.nivel === n && b.dataset.camp === c; });
              for (var i = 1; lipite && i < poz.length; i++) if (poz[i] !== poz[i - 1] + 1) lipite = false;
            }
            txt.innerHTML = a.length === 1
              ? "Locul <strong>" + adrese[0] + "</strong>"
              : a.length + " locuri: <strong>" + adrese.join(", ") + "</strong>" +
                (lipite
                  ? ' <span class="badge verde" style="font-size:10px">lipite — o paletă lată</span>'
                  : ' <span class="badge galben" style="font-size:10px">nu sunt lipite — ies paleți separați</span>');
          });
          document.getElementById("bara-locuri-renunt").addEventListener("click", function (ev) {
            ev.preventDefault();
            alese().forEach(function (b) { b.checked = false; });
            lipite_camp.value = "";
            bara.hidden = true;
          });
        })();

        // ---- Modul de editare: schimbi raftul cu degetul, se salveaza singur
        //
        // Doua moduri pe aceeasi pagina. In mod normal un click pe un loc il
        // ALEGE pentru marfa; in mod editare, acelasi click il SCOATE DIN
        // USO sau il repune. De-aia, cand se intra in editare, selectia de
        // marfa se goleste si bara ei se ascunde: daca ar ramane amandoua
        // active, un click ar face doua lucruri deodata si n-ai sti care.
        (function () {
          var RAND = ${r.id};
          var buton = document.getElementById("buton-editez");
          var panou = document.getElementById("panou-editare");
          var banda = document.querySelector(".ct-banda-editare");
          var stare = document.getElementById("editare-stare");
          var barăMarfa = document.getElementById("bara-locuri");
          var intervalPanou = document.getElementById("editare-interval");
          var intervalText = document.getElementById("editare-interval-text");
          var editez = false;
          var ocupat = false;

          function spune(text, rau) {
            stare.textContent = text || "";
            stare.style.color = rau ? "var(--danger)" : "var(--text-muted)";
          }

          // Orice schimbare rescrie locurile in baza, deci pagina trebuie sa
          // se reciteasca — altfel desenul ar ramane cel vechi si urmatorul
          // click ar porni de la cifre gresite. Mesajul se duce mai departe
          // prin adresa, ca sa se vada dupa reincarcare.
          async function trimite(date, text) {
            if (ocupat) return;
            ocupat = true;
            spune(text || "salvez…");
            try {
              var r = await fetch("/stocuri/ct-park/rand/" + RAND + "/editeaza", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(date).toString(),
              });
              var j = await r.json();
              if (!j.ok) { spune(j.mesaj || "N-a mers.", true); ocupat = false; return; }
              var u = new URL(location.href);
              u.searchParams.set("ok", j.mesaj);
              u.hash = "editez";
              location.href = u.toString();
            } catch (e) {
              spune("N-am putut salva: " + e.message, true);
              ocupat = false;
            }
          }

          function porneste(pornit) {
            editez = pornit;
            panou.hidden = !pornit;
            if (banda) banda.hidden = !pornit;
            document.body.classList.toggle("ct-editez", pornit);
            buton.textContent = pornit ? "Gata, am terminat" : "Editez raftul";
            if (pornit) {
              // Golim selectia de marfa, ca sa nu se amestece cele doua moduri.
              Array.prototype.forEach.call(document.querySelectorAll('input[name="loc"]'), function (b) { b.checked = false; });
              document.getElementById("locuri-lipite").value = "";
              if (barăMarfa) barăMarfa.hidden = true;
            }
          }
          buton.addEventListener("click", function () { porneste(!editez); });
          // Dupa o salvare pagina se reincarca; o aducem inapoi in editare.
          if (location.hash === "#editez") porneste(true);

          // − si + pe un camp.
          document.addEventListener("click", function (ev) {
            var b = ev.target.closest && ev.target.closest(".ct-mic");
            if (!b || !editez) return;
            ev.preventDefault();
            var camp = b.dataset.camp, ce = b.dataset.ce, pas = Number(b.dataset.pas);
            var cifra = document.querySelector('.ct-camp-cifra[data-camp="' + camp + '"][data-ce="' + ce + '"]');
            var acum = Number(cifra.textContent) || 1;
            var nou = acum + pas;
            if (nou < 1) return spune(ce === "paleti" ? "Un câmp are cel puțin un palet." : "Un câmp are cel puțin un nivel.", true);
            var date = { ce: "camp", camp: camp };
            date[ce] = nou;
            trimite(date, "câmpul " + camp + ": " + nou + " " + (ce === "paleti" ? "paleți" : "niveluri") + "…");
          });

          // Click pe un loc, in editare: scoate din uz / repune in uz.
          document.addEventListener("click", function (ev) {
            if (!editez) return;
            var l = ev.target.closest && ev.target.closest(".ct-loc[data-loc]");
            if (!l) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (l.dataset.ocupat) return spune("Pe " + (l.dataset.adresa || "locul ăsta") + " stă marfă. Scoate-o întâi.", true);
            trimite({ ce: "loc", loc: l.dataset.loc }, (l.dataset.blocat ? "repun " : "scot ") + (l.dataset.adresa || "") + "…");
          }, true);

          // + / − un camp la capatul randului.
          Array.prototype.forEach.call(document.querySelectorAll("[data-rand-camp]"), function (b) {
            b.addEventListener("click", function () { trimite({ ce: b.dataset.randCamp }); });
          });

          // Mai multe campuri deodata: bifezi numerele, scrii o cifra, aplici.
          function bifate() {
            return Array.prototype.filter.call(document.querySelectorAll(".bifa-camp"), function (b) { return b.checked; })
              .map(function (b) { return Number(b.value); }).sort(function (x, y) { return x - y; });
          }
          document.addEventListener("change", function (ev) {
            if (!ev.target.classList || !ev.target.classList.contains("bifa-camp")) return;
            var a = bifate();
            intervalPanou.hidden = a.length === 0;
            if (!a.length) return;
            // Daca sunt vecine le spunem ca interval, altfel le insiram: tot
            // la fel se trimit, dar omul vede ce a bifat.
            var vecine = a.every(function (v, i) { return i === 0 || v === a[i - 1] + 1; });
            intervalText.innerHTML = vecine && a.length > 1
              ? "Câmpurile <strong>" + a[0] + "–" + a[a.length - 1] + "</strong>:"
              : "Câmpurile <strong>" + a.join(", ") + "</strong>:";
          });
          document.getElementById("interval-aplica").addEventListener("click", function () {
            var a = bifate();
            if (!a.length) return;
            var niv = document.getElementById("interval-niveluri").value;
            var pal = document.getElementById("interval-paleti").value;
            if (!niv && !pal) return spune("Scrie câte niveluri, câți paleți, sau amândouă.", true);
            var vecine = a.every(function (v, i) { return i === 0 || v === a[i - 1] + 1; });
            if (!vecine) return spune("Deocamdată doar câmpuri lipite. Ai bifat " + a.join(", ") + ".", true);
            var date = { ce: "interval", de_la: a[0], pana_la: a[a.length - 1] };
            if (niv) date.niveluri = niv;
            if (pal) date.paleti = pal;
            trimite(date, "câmpurile " + a[0] + "–" + a[a.length - 1] + "…");
          });
          document.getElementById("interval-renunt").addEventListener("click", function (ev) {
            ev.preventDefault();
            Array.prototype.forEach.call(document.querySelectorAll(".bifa-camp"), function (b) { b.checked = false; });
            intervalPanou.hidden = true;
          });
        })();
      </script>

      <p class="ct-legenda2">
        ${CATEGORII.map((c) => `<span><i style="background:${CULORI_CATEGORII[c]}"></i>${esc(c)}</span>`).join("")}
        <span><i style="background:#eceff3;border:1px solid var(--border)"></i>liber</span>
        <span style="color:var(--text-muted)">Click pe un loc <strong>liber</strong> ca să pui marfă acolo (poți alege mai multe) · click pe unul <strong>ocupat</strong> ca să vezi ce e pe el.</span>
      </p>

      <h2>Zone pe categorii</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-top:-6px;max-width:760px">
        Categoria se pune pe zona de trei paleți dintr-un câmp, nu pe locul singur — aia e unitatea pe care o
        rezervi unei categorii de marfă. Lasă gol ca să eliberezi zona.
      </p>
      <form class="form" method="post" action="/stocuri/ct-park/rand/${r.id}/zone" style="max-width:900px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
          ${niveluri
            .map((n) => n.nivel)
            .reverse()
            .flatMap((nivel) =>
              Array.from({ length: nr(r.campuri) }, (_, j) => {
                const camp = j + 1;
                const z = h.get(`${nivel}|${camp}|1`);
                const val = z ? z.categorie || "" : "";
                return `<label class="field" style="margin:0"><span style="font-size:12px">N${nivel} · câmp ${camp}</span>
                  <select name="z_${nivel}_${camp}">
                    <option value=""${val ? "" : " selected"}>—</option>
                    ${CATEGORII.map((c) => `<option value="${esc(c)}"${val === c ? " selected" : ""}>${esc(c)}</option>`).join("")}
                  </select></label>`;
              })
            )
            .join("")}
        </div>
        <div class="form-actions"><button class="btn" type="submit">Salvează zonele</button></div>
      </form>

      <style>
        .ct-fata { background:#fff; border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; }
        .ct-grila { display:flex; flex-direction:column; gap:6px; min-width:600px; }
        .ct-nivel { display:flex; align-items:stretch; gap:8px; }
        .ct-nivel-eticheta { width:58px; flex:none; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; font-weight:600; font-size:12px; color:var(--text-muted); border-right:2px solid var(--border); }
        .ct-nivel-mm { font-weight:400; font-size:10px; }
        .ct-nivel-campuri { display:flex; gap:8px; flex:1; }
        .ct-camp { flex:1; min-width:96px; }
        .ct-camp-locuri { display:flex; gap:2px; }
        .ct-camp-eticheta { font-size:10px; color:var(--text-muted); text-align:center; margin-top:2px; }
        .ct-loc { flex:1; min-width:26px; border:1px solid var(--border); border-radius:3px; background:#f7f8fa;
                  display:flex; flex-direction:column; align-items:center; justify-content:center; text-decoration:none; color:inherit; overflow:hidden; }
        .ct-loc.ocupat { cursor:pointer; }
        .ct-loc.ocupat:hover { outline:2px solid var(--primary); }
        .ct-loc.lipsa { background:repeating-linear-gradient(45deg,#f0f0f0,#f0f0f0 4px,#fff 4px,#fff 8px); border-style:dashed; }
        .ct-loc.blocat { background:#f0e2e2; }
        .ct-loc-adresa { font-size:10px; color:var(--text-muted); }
        .ct-loc-marfa { font-size:9px; line-height:1.05; text-align:center; padding:0 2px; }
        .ct-podea { margin-top:6px; margin-left:66px; border-top:3px solid #8a8f98; font-size:11px; color:var(--text-muted); padding-top:2px; }
        .ct-legenda2 { display:flex; gap:16px; flex-wrap:wrap; align-items:center; font-size:12px; margin:10px 0 18px; }
        .ct-legenda2 i { display:inline-block; width:12px; height:12px; border-radius:2px; margin-right:6px; vertical-align:-1px; }

        /* Banda de comenzi pe câmp. Are aceeași structură ca un nivel, deci
           se aliniază singură sub coloanele desenului. */
        .ct-banda-editare { margin-top:8px; padding-top:8px; border-top:1px dashed var(--border); }
        .ct-camp-editare { display:flex; flex-direction:column; align-items:center; gap:2px; font-size:11px; }
        .ct-camp-bifa { display:flex; align-items:center; gap:3px; font-weight:600; cursor:pointer; }
        .ct-camp-rand { display:flex; align-items:center; gap:2px; }
        .ct-camp-cifra { min-width:14px; text-align:center; font-weight:600; }
        .ct-camp-um { color:var(--text-muted); font-size:10px; }
        .ct-mic { width:18px; height:18px; line-height:1; padding:0; border:1px solid var(--border);
                  background:#fff; border-radius:3px; cursor:pointer; font-size:12px; }
        .ct-mic:hover { border-color:var(--accent,#2f6fde); color:var(--accent,#2f6fde); }

        /* În editare, un click pe un loc nu-l mai alege pentru marfă: îl
           scoate din uz. Cursorul trebuie să spună asta înainte de click. */
        body.ct-editez .ct-loc.alegibil { cursor:not-allowed; }
        body.ct-editez .ct-loc[data-loc]:hover { outline:2px solid var(--danger,#c0392b); }
        body.ct-editez .ct-loc.blocat[data-loc]:hover { outline-color:var(--accent,#2f6fde); }
      </style>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `CT-Park · rândul ${r.numar}`, active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/rand/:id/zone", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park");
    for (let nivel = 1; nivel <= nr(r.niveluri); nivel++) {
      for (let camp = 1; camp <= nr(r.campuri); camp++) {
        const v = String(ctx.body[`z_${nivel}_${camp}`] || "").trim();
        await db
          .prepare("UPDATE ct_locuri SET categorie = ? WHERE rand_id = ? AND nivel = ? AND camp = ?")
          .run(CATEGORII.includes(v) ? v : null, r.id, nivel, camp);
      }
    }
    redirect(ctx.res, `/stocuri/ct-park/rand/${r.id}`);
  });

  // ---- O paletă ----------------------------------------------------------
  router.get("/stocuri/ct-park/palet/:id", async (ctx) => {
    const p = await db
      .prepare("SELECT p.*, pr.denumire AS produs, pr.cod AS produs_cod, pr.unitate_masura FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id WHERE p.id = ?")
      .get(ctx.params.id);
    if (!p) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/stocuri/ct-park", body: "<p>Paleta nu există.</p>" }));
    const locuri = await db
      .prepare(
        `SELECT l.*, r.numar AS rand_numar, r.id AS rand_id FROM ct_ocupari o
           JOIN ct_locuri l ON l.id = o.loc_id JOIN ct_randuri r ON r.id = l.rand_id
          WHERE o.palet_id = ? ORDER BY l.camp, l.pozitie`
      )
      .all(p.id);
    const iesire = await db
      .prepare("SELECT * FROM ct_iesiri WHERE palet_id = ? ORDER BY id DESC LIMIT 1")
      .get(p.id)
      .catch(() => null);

    const body = `
      ${subtabs("/stocuri/ct-park")}
      <div class="toolbar">
        <a class="btn secondary" href="${locuri.length ? `/stocuri/ct-park/rand/${locuri[0].rand_id}` : "/stocuri/ct-park"}">← Înapoi la rând</a>
        <a class="btn secondary" href="/stocuri/ct-park/etichete?paleti=${p.id}" target="_blank">Tipărește eticheta</a>
      </div>
      <div class="detail-box">
        <h1 style="margin-top:0">${esc(p.cod)} ${p.data_iesire ? '<span class="badge gri">scoasă</span>' : '<span class="badge verde">în depozit</span>'}</h1>
        <div class="detail-grid">
          <div><div class="k">Marfă</div>${p.produs_id ? `<a href="/produse/${p.produs_id}">${esc(p.produs)}</a>` : esc(p.produs_text || "—")}</div>
          <div><div class="k">Cod produs</div>${esc(p.produs_cod || "—")}</div>
          <div><div class="k">Cantitate</div>${nr(p.cantitate) ? nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || p.unitate_masura || "") : "—"}</div>
          <div><div class="k">Lot</div>${esc(p.lot || "—")}</div>
          <div><div class="k">Categorie</div>${pastila(p.categorie) || "—"}</div>
          <div><div class="k">Intrată la</div>${esc(p.data_intrare)}</div>
          <div><div class="k">Scoasă la</div>${esc(p.data_iesire || "—")}</div>
          <div><div class="k">Pusă de</div>${esc(p.creat_de || "—")}</div>
          <div><div class="k">Preț la intrare</div>${
            nr(p.pret_unitar)
              ? `${nr(p.pret_unitar).toLocaleString("ro-RO", { maximumFractionDigits: 4 })} lei / ${esc(p.um || p.unitate_masura || "UM")}<br><span style="color:var(--text-muted);font-size:11px">${esc(p.pret_sursa || "")}</span>`
              : "—"
          }</div>
          <div><div class="k">Valoarea paletei</div>${
            nr(p.pret_unitar) && nr(p.cantitate)
              ? `${(nr(p.cantitate) * nr(p.pret_unitar)).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei`
              : "—"
          }</div>
        </div>
        <p style="margin-top:12px"><strong>Adresa:</strong>
          ${locuri.map((l) => `<a href="/stocuri/ct-park/rand/${l.rand_id}" class="badge gri" style="text-decoration:none">${esc(l.adresa)}</a>`).join(" ")}
          ${locuri.length > 1 ? `<span style="color:var(--text-muted);font-size:12px"> — marfă lată, ține ${locuri.length} locuri</span>` : ""}
        </p>
        ${p.observatii ? `<p style="white-space:pre-wrap"><strong>Observații:</strong> ${esc(p.observatii)}</p>` : ""}
        ${
          iesire
            ? `<p style="margin-top:10px"><strong>Ieșire:</strong> ${esc(String(iesire.data || "").slice(0, 10))} → ${esc(etichetaDestinatie(iesire.destinatie))}${
                iesire.comanda_numar ? " · " + esc(iesire.comanda_numar) + (iesire.client ? " · " + esc(iesire.client) : "") : ""
              }${
                nr(iesire.cost)
                  ? ` · cost ieșit <strong>${nr(iesire.cost).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei</strong> <span style="color:var(--text-muted);font-size:12px">(${esc(iesire.cost_temei || "")})</span>`
                  : ""
              }${iesire.peste_rand ? `<br><span style="color:var(--warn);font-size:12px">Peste rând: ${esc(iesire.peste_rand)}</span>` : ""}</p>`
            : ""
        }
      </div>
      ${
        p.data_iesire
          ? ""
          : // Scoaterea trece prin ecranul de ieșire, ca să se aleagă destinația.
            // Un buton care doar „scoate" ar lăsa marfa fără drum scris nicăieri.
            `<a class="btn secondary" href="/stocuri/ct-park/iesire?palet=${p.id}">Scoate paleta din depozit →</a>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: esc(p.cod), active: "/stocuri/ct-park", body }));
  });

  // Ruta veche de scoatere, fără destinație. Nu mai scoate nimic: trimite la
  // ecranul de ieșire, unde destinația e obligatorie. E păstrată pentru
  // eventuale linkuri sau taburi rămase deschise din versiunea dinainte.
  router.post("/stocuri/ct-park/palet/:id/scoate", async (ctx) => {
    redirect(ctx.res, "/stocuri/ct-park/iesire?palet=" + encodeURIComponent(ctx.params.id));
  });

  // ---- Ieșirea de marfă ---------------------------------------------------
  //
  // Simetric cu intrarea, cu o singură diferență care contează: la ieșire
  // trebuie spus OBLIGATORIU unde se duce paleta. Marfa care „a plecat" fără
  // să se știe unde e marfă pierdută pe hârtie, chiar dacă în realitate a
  // ajuns unde trebuia.
  //
  // Trei drumuri: producție, fulfillment, sau o comandă anume. La comandă se
  // alege exact comanda, iar clientul și numărul ei ajung pe etichetă.
  const DESTINATII = [
    ["productie", "Producție", "Materie primă care intră în fabricație."],
    ["fulfillment", "Fulfillment", "Marfă care pleacă spre pregătirea comenzilor."],
    ["comanda", "Comandă", "Livrare pe o comandă anume — se alege mai jos."],
  ];
  const eDestinatie = (v) => DESTINATII.some(([c]) => c === String(v || ""));
  const etichetaDestinatie = (v) => (DESTINATII.find(([c]) => c === String(v || "")) || [, String(v || "")])[1];

  async function comenziDeschise() {
    return db
      .prepare(
        `SELECT c.id, c.numar, c.data, c.status, p.nume AS client
           FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
          WHERE c.status NOT IN ('anulata')
          ORDER BY c.id DESC LIMIT 300`
      )
      .all()
      .catch(() => []);
  }

  router.get("/stocuri/ct-park/iesire", async (ctx) => {
    const cauta = String(ctx.query.q || "").trim();
    const preselectat = nr(ctx.query.palet) || 0;
    const undeCauta = cauta
      ? " AND (COALESCE(pr.denumire, p.produs_text) ILIKE ? OR p.cod ILIKE ? OR COALESCE(p.lot,'') ILIKE ?)"
      : "";
    const argCauta = cauta ? [`%${cauta}%`, `%${cauta}%`, `%${cauta}%`] : [];

    // FIFO: primul intrat, primul ieșit. Lista se ordonează pe marfă, iar în
    // interiorul fiecărei mărfi de la cea mai veche paletă la cea mai nouă —
    // nu de la ultima introdusă, cum era înainte. Așa, ce trebuie scos e
    // mereu primul rând al grupului lui, nu ceva de căutat prin listă.
    const paleti = await db
      .prepare(
        `SELECT p.id, p.cod, p.cantitate, p.um, p.lot, p.categorie, p.data_intrare,
                p.pret_unitar, p.pret_sursa,
                COALESCE(pr.denumire, p.produs_text) AS marfa
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.data_iesire IS NULL${undeCauta}
          ORDER BY COALESCE(pr.denumire, p.produs_text, ''), p.data_intrare ASC, p.id ASC
          LIMIT 400`
      )
      .all(...argCauta);

    // Care e „la rând" pentru fiecare marfă: cea mai veche paletă neieșită.
    // Marfa scrisă liber se compară după text, fiindcă n-are produs în catalog.
    const cheieMarfa = (x) => String(x.marfa || "—").trim().toLowerCase();
    const laRand = new Map();
    for (const x of paleti) {
      const k = cheieMarfa(x);
      if (!laRand.has(k)) laRand.set(k, Number(x.id));
    }

    const adrese = await db
      .prepare(
        `SELECT o.palet_id, l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id
          ORDER BY l.camp, l.pozitie`
      )
      .all();
    const ha = new Map();
    for (const a of adrese) {
      const k = Number(a.palet_id);
      if (!ha.has(k)) ha.set(k, []);
      ha.get(k).push(a.adresa);
    }

    const comenzi = await comenziDeschise();

    const body = `
      ${subtabs("/stocuri/ct-park/iesire")}
      ${ctx.query.eroare ? `<div class="flash flash-rosu">${esc(String(ctx.query.eroare))}</div>` : ""}
      <h1 style="margin:6px 0 2px">Ieșire marfă din CT-Park</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:820px">
        Bifezi paleții care pleacă și spui <strong>unde se duc</strong> — fără destinație nu iese nimic din depozit.
        Locurile se eliberează pe loc, iar la final primești etichetele de ieșire, tot 100 × 150 mm.
      </p>
      <p class="explic" style="max-width:820px">
        Lista e pusă în ordinea <strong>FIFO — primul intrat, primul ieșit</strong>: pe fiecare marfă, cea mai veche
        paletă e prima, cu semnul <span class="badge verde">prima la rând</span>. Regula e aceeași pentru materie primă,
        consumabile, marfă de vânzare <strong>și produs finit</strong> — orice iese din depozit. Poți sări peste una mai veche — depozitul are motive reale, o paletă blocată în
        spate sau un lot cerut de client — dar atunci scrii de ce, iar motivul rămâne scris pe ieșire. Costul care pleacă
        din depozit se ia cu prețul paletei ăsteia, nu cu o medie.
      </p>

      <form class="filtre" method="get" action="/stocuri/ct-park/iesire">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după marfă, cod de paletă sau lot…" style="min-width:300px">
        <button class="btn small" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary small" href="/stocuri/ct-park/iesire">Arată tot</a>` : ""}
      </form>

      <form class="form" method="post" action="/stocuri/ct-park/iesire" style="max-width:960px">
        <div class="field">
          <span>Unde se duce marfa</span>
          <div class="destinatii">
            ${DESTINATII.map(
              ([cheie, eticheta, explicatie]) => `<label class="destinatie">
                <input type="radio" name="destinatie" value="${cheie}" required>
                <span><strong>${esc(eticheta)}</strong><br><span class="ajutor" style="margin:0">${esc(explicatie)}</span></span>
              </label>`
            ).join("")}
          </div>
        </div>

        <label class="field" id="camp-comanda">
          <span>Care comandă</span>
          <select name="comanda_id">
            <option value="">— alege comanda —</option>
            ${comenzi
              .map(
                (c) =>
                  `<option value="${c.id}">${esc(c.numar || "#" + c.id)} · ${esc(c.client)} · ${esc(String(c.data || "").slice(0, 10))}${
                    c.status ? " · " + esc(c.status) : ""
                  }</option>`
              )
              .join("")}
          </select>
          <span class="ajutor">Obligatoriu dacă destinația e „Comandă". Clientul, numărul și data ajung pe etichetă.</span>
        </label>

        <label class="field"><span>Observații (opțional)</span><input name="observatii" placeholder="ex. ridicat de Cargus, AWB 123"></label>

        ${
          paleti.length
            ? table(
                ['<input type="checkbox" id="bifa-toti">', "Paletă", "Marfă", "Cantitate", "Lot", "Adresă", "Intrată la", "Cost", "Rând"],
                paleti.map((p) => {
                  const adr = ha.get(Number(p.id)) || [];
                  const prima = laRand.get(cheieMarfa(p)) === Number(p.id);
                  const val = nr(p.cantitate) * nr(p.pret_unitar);
                  return [
                    `<input type="checkbox" class="bifa-palet" name="paleti" value="${p.id}"
                            data-marfa="${esc(cheieMarfa(p))}" data-data="${esc(String(p.data_intrare || ""))}"
                            data-cod="${esc(p.cod)}"${preselectat === Number(p.id) ? " checked" : ""}>`,
                    `<a href="/stocuri/ct-park/palet/${p.id}">${esc(p.cod)}</a>`,
                    esc(p.marfa || "—"),
                    nr(p.cantitate) ? `${nr(p.cantitate).toLocaleString("ro-RO")} ${esc(p.um || "")}` : "—",
                    esc(p.lot || "—"),
                    adr.length ? `<code>${adr.map((a) => esc(a)).join(" + ")}</code>` : "—",
                    esc(String(p.data_intrare || "").slice(0, 10)),
                    nr(p.pret_unitar)
                      ? `${val.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei<br><span style="color:var(--text-muted);font-size:11px">${nr(p.pret_unitar).toLocaleString("ro-RO", { maximumFractionDigits: 4 })} / ${esc(p.um || "UM")}</span>`
                      : `<span style="color:var(--text-muted)">fără preț</span>`,
                    prima ? `<span class="badge verde">prima la rând</span>` : `<span style="color:var(--text-muted);font-size:12px">după</span>`,
                  ];
                })
              )
            : `<p style="color:var(--text-muted)">${cauta ? "Niciun palet care să semene cu „" + esc(cauta) + "”." : "Nu e nimic în depozit."}</p>`
        }

        <label class="field" id="camp-peste-rand" style="display:none;border-left:3px solid var(--warn);padding-left:10px">
          <span>De ce scoți peste rând</span>
          <input name="peste_rand" placeholder="ex. paleta veche e blocată în spate, clientul cere lotul ăsta">
          <span class="ajutor">Ai bifat o paletă deși există una mai veche din aceeași marfă. Scrie motivul — rămâne pe ieșire.</span>
        </label>

        <div class="form-actions">
          <button class="btn" type="submit"${paleti.length ? "" : " disabled"}>Scoate paleții și tipărește etichetele →</button>
          <a class="btn secondary" href="/stocuri/ct-park">Renunță</a>
        </div>
      </form>

      <script>
      (function () {
        var toti = document.getElementById("bifa-toti");
        if (toti) toti.addEventListener("change", function () {
          var b = document.querySelectorAll(".bifa-palet");
          for (var i = 0; i < b.length; i++) b[i].checked = toti.checked;
          peste();
        });

        // FIFO, verificat în pagină înainte de trimitere: dacă bifezi o paletă
        // și rămâne nebifată una mai veche din aceeași marfă, apare câmpul de
        // motiv. Nu blocăm — depozitul are motive reale să sară peste (paleta
        // din spate, lotul cerut de client) — dar motivul se scrie și rămâne.
        var campPeste = document.getElementById("camp-peste-rand");
        function sarite() {
          var b = document.querySelectorAll(".bifa-palet");
          var bifate = {}, lista = [];
          for (var i = 0; i < b.length; i++) if (b[i].checked) bifate[b[i].dataset.marfa] = true;
          for (var i = 0; i < b.length; i++) {
            var x = b[i];
            if (x.checked || !bifate[x.dataset.marfa]) continue;
            // paleta asta e mai veche decât cel puțin una bifată din marfa ei?
            for (var j = 0; j < b.length; j++) {
              var y = b[j];
              if (!y.checked || y.dataset.marfa !== x.dataset.marfa) continue;
              if (x.dataset.data < y.dataset.data || (x.dataset.data === y.dataset.data && Number(x.value) < Number(y.value))) {
                lista.push(x.dataset.cod);
                break;
              }
            }
          }
          return lista;
        }
        function peste() {
          if (!campPeste) return;
          var l = sarite();
          campPeste.style.display = l.length ? "" : "none";
          var inp = campPeste.querySelector("input");
          if (inp) inp.required = l.length > 0;
          var aj = campPeste.querySelector(".ajutor");
          if (aj && l.length) {
            aj.textContent = "Rămân în depozit palete mai vechi din aceeași marfă: " + l.slice(0, 6).join(", ") +
              (l.length > 6 ? " și încă " + (l.length - 6) : "") + ". Scrie de ce le sari — motivul rămâne pe ieșire.";
          }
        }
        var bifePalet = document.querySelectorAll(".bifa-palet");
        for (var i = 0; i < bifePalet.length; i++) bifePalet[i].addEventListener("change", peste);
        peste();
        // Câmpul comenzii apare doar când destinația e „Comandă" — altfel e
        // o cutie goală care încurcă.
        var camp = document.getElementById("camp-comanda");
        var radio = document.querySelectorAll('input[name="destinatie"]');
        function comuta() {
          var ales = null;
          for (var i = 0; i < radio.length; i++) if (radio[i].checked) ales = radio[i].value;
          camp.style.display = ales === "comanda" ? "" : "none";
          camp.querySelector("select").required = ales === "comanda";
        }
        for (var i = 0; i < radio.length; i++) radio[i].addEventListener("change", comuta);
        comuta();
      })();
      </script>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Ieșire marfă CT-Park", active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/iesire", async (ctx) => {
    const b = ctx.body;
    const ids = [].concat(b.paleti || []).map((x) => nr(x)).filter(Boolean);
    const destinatie = String(b.destinatie || "");
    const inapoi = (mesaj) => redirect(ctx.res, "/stocuri/ct-park/iesire?eroare=" + encodeURIComponent(mesaj));

    if (!ids.length) return inapoi("N-ai bifat niciun palet.");
    if (!eDestinatie(destinatie)) return inapoi("Alege unde se duce marfa: producție, fulfillment sau comandă.");

    let comanda = null;
    if (destinatie === "comanda") {
      const cid = nr(b.comanda_id);
      if (!cid) return inapoi("La destinația „Comandă” trebuie aleasă exact comanda.");
      comanda = await db
        .prepare(
          `SELECT c.id, c.numar, c.data, p.nume AS client FROM comenzi c
             JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?`
        )
        .get(cid);
      if (!comanda) return inapoi("Comanda aleasă nu mai există.");
    }

    // Adresa de unde pleacă fiecare paletă, luată ÎNAINTE de a elibera
    // locurile — după ștergere n-am mai avea de unde s-o scriem pe etichetă.
    const adrese = await db
      .prepare(
        `SELECT o.palet_id, l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id
          WHERE o.palet_id IN (${ids.map(() => "?").join(",")}) ORDER BY l.camp, l.pozitie`
      )
      .all(...ids);
    const ha = new Map();
    for (const a of adrese) {
      const k = Number(a.palet_id);
      if (!ha.has(k)) ha.set(k, []);
      ha.get(k).push(a.adresa);
    }

    const azi = aziStr();
    const cine = ctx.user ? ctx.user.nume : null;
    const motivPeste = String(b.peste_rand || "").trim() || null;
    const scoase = [];
    for (const id of ids) {
      const p = await db
        .prepare(
          `SELECT p.id, p.cantitate, p.um, p.produs_id, p.produs_text, p.data_intrare,
                  p.pret_unitar, p.pret_sursa, COALESCE(pr.denumire, p.produs_text) AS marfa
             FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
            WHERE p.id = ? AND p.data_iesire IS NULL`
        )
        .get(id);
      if (!p) continue; // deja ieșit între timp — nu-l scoatem de două ori

      // FIFO, verificat și pe server: câte palete mai vechi din aceeași marfă
      // rămân în depozit după ieșirea asta. Verificarea din pagină e o
      // comoditate; asta e cea care ajunge în date.
      const maiVechi = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM ct_paleti x LEFT JOIN produse xr ON xr.id = x.produs_id
            WHERE x.data_iesire IS NULL AND x.id <> ?
              AND LOWER(COALESCE(xr.denumire, x.produs_text, '')) = LOWER(COALESCE(?, ''))
              AND (x.data_intrare < ? OR (x.data_intrare = ? AND x.id < ?))
              AND x.id NOT IN (${ids.map(() => "?").join(",")})`
        )
        .get(id, p.marfa, p.data_intrare, p.data_intrare, id, ...ids)
        .catch(() => ({ n: 0 }));
      const sarite = Number((maiVechi && maiVechi.n) || 0);

      // Costul care iese efectiv din depozit, cu prețul paletei ăsteia.
      const cost = nr(p.cantitate) * nr(p.pret_unitar);
      const temei = nr(p.pret_unitar) ? p.pret_sursa || "preț pe paletă" : "fără preț la intrare";

      await db.prepare("UPDATE ct_paleti SET data_iesire = ? WHERE id = ?").run(azi, id);
      await db.prepare("DELETE FROM ct_ocupari WHERE palet_id = ?").run(id);
      await db
        .prepare(
          `INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, client, comanda_numar, comanda_data, adresa, data, observatii, creat_de, cost, cost_temei, peste_rand)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          destinatie,
          comanda ? comanda.id : null,
          comanda ? comanda.client : null,
          comanda ? comanda.numar || "#" + comanda.id : null,
          comanda ? String(comanda.data || "").slice(0, 10) : null,
          (ha.get(Number(id)) || []).join(" + ") || null,
          azi,
          String(b.observatii || "").trim() || null,
          cine,
          cost > 0 ? Math.round(cost * 100) / 100 : null,
          temei,
          sarite ? `${sarite} ${sarite === 1 ? "paletă mai veche rămasă" : "palete mai vechi rămase"}${motivPeste ? ": " + motivPeste : " — fără motiv scris"}` : null
        );
      scoase.push(id);
    }

    if (!scoase.length) return inapoi("Paleții bifați ieșiseră deja din depozit.");
    redirect(ctx.res, "/stocuri/ct-park/etichete?paleti=" + scoase.join(","));
  });

  // ---- Paleții din depozit -----------------------------------------------
  router.get("/stocuri/ct-park/paleti", async (ctx) => {
    const toate = String(ctx.query.toate || "") === "1";
    const paleti = await db
      .prepare(
        `SELECT p.*, pr.denumire AS produs,
                (SELECT COUNT(*) FROM ct_ocupari o WHERE o.palet_id = p.id) AS locuri
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          ${toate ? "" : "WHERE p.data_iesire IS NULL"}
          ORDER BY p.data_intrare DESC, p.id DESC LIMIT 400`
      )
      .all();
    const adrese = await db
      .prepare(
        `SELECT o.palet_id, l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id ORDER BY l.camp, l.pozitie`
      )
      .all();
    const ha = new Map();
    for (const a of adrese) {
      const k = Number(a.palet_id);
      if (!ha.has(k)) ha.set(k, []);
      ha.get(k).push(a.adresa);
    }

    // Valoarea stocului: din prețul cu care a intrat fiecare paletă, nu dintr-o
    // medie pe produs. Spunem și câți paleți n-au preț, ca să se vadă cât din
    // cifră lipsește.
    const inDepozit = paleti.filter((p) => !p.data_iesire);
    const valoare = inDepozit.reduce((s2, p) => s2 + nr(p.cantitate) * nr(p.pret_unitar), 0);
    const faraPret = inDepozit.filter((p) => !nr(p.pret_unitar)).length;

    const body = `
      ${subtabs("/stocuri/ct-park/paleti")}
      <div class="toolbar"><a class="btn" href="/stocuri/ct-park/intrare">+ Intrare marfă</a></div>
      <div class="cards">
        <div class="card"><div class="label">Paleți în depozit</div><div class="value">${inDepozit.length}</div></div>
        <div class="card"><div class="label">Valoarea stocului</div>
          <div class="value">${valoare.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei</div>
          <div class="mic">${faraPret ? `${faraPret} ${faraPret === 1 ? "paletă n-are" : "paleți n-au"} preț la intrare, deci nu ${faraPret === 1 ? "e" : "sunt"} la socoteală` : "toți paleții au preț la intrare"}</div></div>
      </div>
      ${table(
        ["Cod", "Marfă", "Cantitate", "Lot", "Categorie", "Adresă", "Intrată", "Valoare", "Stare", ""],
        paleti.map((p) => [
          `<a href="/stocuri/ct-park/palet/${p.id}">${esc(p.cod)}</a>`,
          p.produs_id ? `<a href="/produse/${p.produs_id}">${esc(p.produs || "—")}</a>` : esc(p.produs_text || "—"),
          nr(p.cantitate) ? nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "") : "—",
          esc(p.lot || "—"),
          pastila(p.categorie) || "—",
          (ha.get(Number(p.id)) || []).map((a) => esc(a)).join(" ") || '<span class="badge gri">fără loc</span>',
          esc(p.data_intrare),
          nr(p.pret_unitar)
            ? (nr(p.cantitate) * nr(p.pret_unitar)).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei"
            : `<span style="color:var(--text-muted)">fără preț</span>`,
          p.data_iesire ? `<span class="badge gri">scoasă ${esc(p.data_iesire)}</span>` : '<span class="badge verde">în depozit</span>',
          `<a class="btn small secondary" href="/stocuri/ct-park/etichete?paleti=${p.id}" target="_blank">Etichetă</a>`,
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">
        ${toate ? `<a href="/stocuri/ct-park/paleti">Doar paleții din depozit</a>` : `<a href="/stocuri/ct-park/paleti?toate=1">Arată și paleții scoși</a>`}
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Paleți în CT-Park", active: "/stocuri/ct-park", body }));
  });

  // ---- Intrare marfă -----------------------------------------------------
  // Doi pași, ca la depozit: întâi spui ce intră și pe câți paleți, apoi îți
  // propune ERP-ul locurile libere și le confirmi. Pasul doi e important —
  // omul vede exact unde va merge marfa înainte să care ceva.
  router.get("/stocuri/ct-park/intrare", async (ctx) => {
    const randuri = await sumarRanduri();
    // Furnizorii, ca să se poată alege la recepție de unde a venit marfa.
    // Fără asta, „de la cine e paleta asta" se poate doar deduce din facturi.
    const furnizori = await db
      .prepare("SELECT id, nume FROM parteneri WHERE tip = 'furnizor' ORDER BY nume")
      .all()
      .catch(() => []);
    const cauta = String(ctx.query.q || "").trim();
    let gasite = [];
    if (cauta) {
      gasite = await db
        .prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE activ = 1 AND (denumire ILIKE ? OR cod ILIKE ?) ORDER BY denumire LIMIT 40")
        .all(`%${cauta}%`, `%${cauta}%`);
    }

    if (!randuri.length) return redirect(ctx.res, "/stocuri/ct-park");

    // Locurile arătate cu degetul pe harta rândului. Când vin de acolo,
    // ERP-ul nu mai propune nimic: omul a ales deja, iar a-i propune altceva
    // peste alegerea lui e exact felul în care un ecran devine enervant.
    // „locuri" e forma buna, lipita cu virgula de JS-ul hartii. „loc" e
    // plasa de siguranta: daca JS-ul n-a apucat sa ruleze, parserul lasa
    // macar ultima casuta bifata, si e mai bine sa pornim cu un loc decat
    // cu niciunul si fara nicio explicatie.
    const aleseDinHarta = String(ctx.query.locuri || ctx.query.loc || "")
      .split(",").map((x) => parseInt(x, 10)).filter(Boolean);
    let locuriAlese = [];
    if (aleseDinHarta.length) {
      locuriAlese = await db
        .prepare(
          `SELECT l.*, r.numar AS rand_numar FROM ct_locuri l JOIN ct_randuri r ON r.id = l.rand_id
            WHERE l.id IN (${aleseDinHarta.map(() => "?").join(",")})
            ORDER BY l.nivel, l.camp, l.pozitie`
        )
        .all(...aleseDinHarta)
        .catch(() => []);
    }

    const body = `
      ${subtabs("/stocuri/ct-park/intrare")}
      <h1 style="margin:6px 0 2px">Intrare marfă în CT-Park</h1>
      ${
        locuriAlese.length
          ? `<div class="detail-box" style="border-left:4px solid var(--accent,#2f6fde);margin-bottom:14px">
               <strong>${locuriAlese.length === 1 ? "Locul ales" : locuriAlese.length + " locuri alese"} de pe hartă:</strong>
               ${locuriAlese.map((l) => `<span class="badge albastru">${esc(l.adresa)}</span>`).join(" ")}
               <p style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">
                 Marfa se pune fix aici — ERP-ul nu mai caută altundeva. Scrie mai jos ce intră.
                 <a href="/stocuri/ct-park/rand/${locuriAlese[0].rand_id}">Înapoi la hartă</a> dacă vrei alte locuri.
               </p>
             </div>`
          : `<p style="margin:0 0 14px;color:var(--text-muted);font-size:13px">
               Pasul 1: ce intră și pe câți paleți. Pasul 2: ERP-ul propune locurile libere, tu le confirmi și primești
               etichetele de 100 × 150 mm cu adresa generată.
               <br>Sau deschide <a href="/stocuri/ct-park">harta</a>, dă click pe locurile libere unde vrei marfa, și
               vino înapoi aici cu ele alese.
             </p>`
      }

      <form class="filtre" method="get" action="/stocuri/ct-park/intrare">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută produsul în catalog…" style="min-width:280px">
        ${ctx.query.rand ? `<input type="hidden" name="rand" value="${esc(String(ctx.query.rand))}">` : ""}
        <button class="btn small" type="submit">Caută</button>
      </form>

      <form class="form" method="post" action="/stocuri/ct-park/intrare" style="max-width:900px">
        <input type="hidden" name="locuri_alese" value="${esc(aleseDinHarta.join(","))}">
        ${
          gasite.length
            ? `<div class="field"><span>Produsul găsit</span>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
                  ${gasite
                    .map(
                      (p) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:0;font-size:13px">
                        <input type="radio" name="produs_id" value="${p.id}" data-um="${esc(p.unitate_masura || "")}">
                        <span>${esc(p.denumire)}<br><span style="color:var(--text-muted);font-size:11px">${esc(p.cod || "fără cod")} · ${esc(p.unitate_masura || "")}</span></span>
                      </label>`
                    )
                    .join("")}
                </div></div>`
            : cauta
              ? `<p style="color:var(--text-muted)">Niciun produs care să semene cu „${esc(cauta)}". Scrie denumirea liber mai jos.</p>`
              : ""
        }
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:14px">
          <label class="field">…sau denumirea scrisă liber<input name="produs_text" placeholder="folie stretch 23µ reciclat"></label>
          <label class="field">Cantitate totală<input type="number" name="cantitate" min="0" step="0.01"></label>
          <label class="field">UM<input name="um" placeholder="kg"></label>
          <label class="field">Preț de achiziție (lei / UM)<input type="number" name="pret_unitar" min="0" step="0.0001" placeholder="ex. 7,35"></label>
        </div>
        <p class="explic" style="margin-top:-6px">
          Prețul rămâne lipit de paleta asta. Când marfa iese, se scoate cu costul cu care a intrat — ăsta e
          rostul lui FIFO. Dacă îl lași gol, se ia prețul de achiziție de pe produs, iar pe paletă scrie
          că e luat de acolo, nu de pe factura ei.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Furnizor
            <select name="furnizor_id">
              <option value="">— nu știu acum —</option>
              ${(furnizori || []).map((f) => `<option value="${f.id}">${esc(f.nume)}</option>`).join("")}
            </select>
          </label>
          <label class="field">…sau scris liber<input name="furnizor_text" placeholder="dacă nu e în listă"></label>
          <label class="field">Lot<input name="lot"></label>
          <label class="field">Categorie
            <select name="categorie">
              <option value="">—</option>
              ${CATEGORII.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            </select>
          </label>
          <label class="field">Câți paleți<input type="number" name="paleti" min="1" max="60"
                 value="${locuriAlese.length ? 1 : 1}" required></label>
          <label class="field">Locuri pe paletă
            <select name="locuri">
              <option value="1">1 — paletă normală</option>
              <option value="2">2 — marfă lată</option>
              <option value="3">3 — marfă foarte lată</option>
            </select>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
          <label class="field">Rând preferat
            <select name="rand_id">
              <option value="">oriunde e liber</option>
              ${randuri.map((r) => `<option value="${r.id}"${String(ctx.query.rand || "") === String(r.id) ? " selected" : ""}>Rândul ${r.numar}${r.eticheta ? " · " + esc(r.eticheta) : ""} (${r.locuri - r.ocupate} libere)</option>`).join("")}
            </select>
          </label>
          <label class="field">Observații<input name="observatii"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Caută locurile libere →</button></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Intrare marfă CT-Park", active: "/stocuri/ct-park", body }));
  });

  // Pasul 2: propunerea. Caută grupuri de locuri libere lipite în același
  // câmp și nivel — o paletă lată nu se poate rupe în două câmpuri.
  router.post("/stocuri/ct-park/intrare", async (ctx) => {
    const b = ctx.body;
    const catePaleti = Math.min(60, Math.max(1, Math.round(nr(b.paleti) || 1)));
    const cuFurnizorLaIntrare = await areColoana("ct_paleti", "furnizor_id");
    const cateLocuri = Math.min(3, Math.max(1, Math.round(nr(b.locuri) || 1)));
    const categorie = CATEGORII.includes(String(b.categorie || "")) ? String(b.categorie) : null;
    const randId = nr(b.rand_id) || null;

    const libere = await db
      .prepare(
        `SELECT l.*, r.numar AS rand_numar, r.eticheta AS rand_eticheta
           FROM ct_locuri l
           JOIN ct_randuri r ON r.id = l.rand_id AND r.activ = 1
          WHERE l.blocat = 0
            AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
            ${randId ? "AND l.rand_id = ?" : ""}
          ORDER BY l.nivel, r.numar, l.camp, l.pozitie`
      )
      .all(...(randId ? [randId] : []));

    // Locurile libere, strânse pe „rând|nivel|câmp", ca să pot tăia din ele
    // felii de câte `cateLocuri` poziții consecutive.
    const peCamp = new Map();
    for (const l of libere) {
      const k = `${l.rand_id}|${l.nivel}|${l.camp}`;
      if (!peCamp.has(k)) peCamp.set(k, []);
      peCamp.get(k).push(l);
    }

    // Potrivirea pe categorie e o preferință, nu o regulă: dacă zona e
    // rezervată altei categorii o lăsăm la urmă, dar n-o interzicem — mai
    // bine pui marfa undeva decât s-o lași în curte.
    const scor = (grup) => {
      const c = grup[0].categorie;
      const potrivitZona = categorie && c === categorie ? 0 : !c ? 1 : 2;
      const potrivitRand = categorie && grup[0].rand_eticheta === categorie ? 0 : 1;
      return potrivitZona * 10 + potrivitRand * 3 + nr(grup[0].nivel);
    };

    // Locurile arătate cu degetul pe hartă. Când există, propunerea automată
    // nu mai rulează deloc: omul a ales, iar a-i propune altceva peste
    // alegerea lui e felul în care un ecran devine enervant.
    //
    // Se verifică DIN NOU că sunt libere. Între click și salvare poate trece
    // un sfert de oră, iar altcineva poate pune marfă acolo — iar atunci un
    // palet ar intra peste altul, în bază, fără ca nimeni să vadă.
    const dinHarta = String(b.locuri_alese || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean);
    let alese;
    let ocupateIntreTimp = [];
    if (dinHarta.length) {
      const libereDupaId = new Map(libere.map((l) => [Number(l.id), l]));
      const bune = [];
      for (const id of dinHarta) {
        const l = libereDupaId.get(id);
        if (l) bune.push(l);
        else ocupateIntreTimp.push(id);
      }
      // Locurile lipite, în același câmp și nivel, formează o paletă lată.
      // Cele răzlețe ies ca paleți separați — exact ce spune și bara de pe
      // hartă când le bifezi.
      bune.sort((x, y) => nr(x.nivel) - nr(y.nivel) || nr(x.camp) - nr(y.camp) || nr(x.pozitie) - nr(y.pozitie));
      alese = [];
      let curent = [];
      for (const l of bune) {
        const ultim = curent[curent.length - 1];
        const lipit =
          ultim && nr(ultim.nivel) === nr(l.nivel) && nr(ultim.camp) === nr(l.camp) &&
          nr(l.pozitie) === nr(ultim.pozitie) + 1 && curent.length < cateLocuri;
        if (lipit) curent.push(l);
        else { if (curent.length) alese.push(curent); curent = [l]; }
      }
      if (curent.length) alese.push(curent);
    } else {
      const grupuri = [];
      for (const [, locuri] of peCamp) {
        locuri.sort((x, y) => nr(x.pozitie) - nr(y.pozitie));
        for (let i = 0; i + cateLocuri <= locuri.length; ) {
          const felie = locuri.slice(i, i + cateLocuri);
          const consecutive = felie.every((l, k) => k === 0 || nr(l.pozitie) === nr(felie[k - 1].pozitie) + 1);
          if (consecutive) {
            grupuri.push(felie);
            i += cateLocuri;
          } else i += 1;
        }
      }
      grupuri.sort((a2, b2) => scor(a2) - scor(b2));
      alese = grupuri.slice(0, catePaleti);
    }

    const produs = nr(b.produs_id)
      ? await db.prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE id = ?").get(nr(b.produs_id))
      : null;
    const numeMarfa = produs ? produs.denumire : String(b.produs_text || "").trim() || "marfă";
    const cantitateTotala = nr(b.cantitate);
    const perPaleta = catePaleti > 0 ? cantitateTotala / catePaleti : 0;

    const ascunse = `
      <input type="hidden" name="produs_id" value="${produs ? produs.id : ""}">
      <input type="hidden" name="produs_text" value="${esc(String(b.produs_text || ""))}">
      <input type="hidden" name="um" value="${esc(String(b.um || (produs ? produs.unitate_masura : "") || ""))}">
      <input type="hidden" name="pret_unitar" value="${esc(String(b.pret_unitar || ""))}">
      <input type="hidden" name="furnizor_id" value="${esc(String(b.furnizor_id || ""))}">
      <input type="hidden" name="furnizor_text" value="${esc(String(b.furnizor_text || ""))}">
      <input type="hidden" name="lot" value="${esc(String(b.lot || ""))}">
      <input type="hidden" name="categorie" value="${esc(categorie || "")}">
      <input type="hidden" name="observatii" value="${esc(String(b.observatii || ""))}">`;

    const body = `
      ${subtabs("/stocuri/ct-park/intrare")}
      <div class="toolbar"><a class="btn secondary" href="/stocuri/ct-park/intrare">← Schimbă marfa</a></div>
      <h1 style="margin:6px 0 2px">${esc(numeMarfa)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px">
        ${catePaleti} palet${catePaleti === 1 ? "ă" : "e"} × ${cateLocuri} loc${cateLocuri === 1 ? "" : "uri"}
        ${cantitateTotala ? `· ${cantitateTotala.toLocaleString("ro-RO")} ${esc(String(b.um || ""))} în total, ${perPaleta.toLocaleString("ro-RO", { maximumFractionDigits: 2 })} pe paletă` : ""}
        ${categorie ? "· " + esc(categorie) : ""}
      </p>

      ${
        ocupateIntreTimp.length
          ? `<div class="detail-box" style="border-left:4px solid var(--danger)">
              <strong>${ocupateIntreTimp.length} ${ocupateIntreTimp.length === 1 ? "loc ales nu mai e liber" : "locuri alese nu mai sunt libere"}.</strong>
              Cineva a pus marfă acolo între timp. Restul se poate ocupa normal; pentru ce lipsește,
              întoarce-te la hartă și alege altceva.
            </div>`
          : ""
      }
      ${
        !dinHarta.length && alese.length < catePaleti
          ? `<div class="detail-box" style="border-left:4px solid var(--danger)">
              Am găsit doar <strong>${alese.length}</strong> ${alese.length === 1 ? "loc potrivit" : "locuri potrivite"} din ${catePaleti} cerute.
              ${cateLocuri > 1 ? "Marfa lată are nevoie de poziții lipite în același câmp — poate n-au mai rămas destule." : "Depozitul e aproape plin."}
              Poți ocupa ce s-a găsit și restul mai târziu.
            </div>`
          : ""
      }

      <form class="form" method="post" action="/stocuri/ct-park/ocupa" style="max-width:960px">
        ${ascunse}
        <input type="hidden" name="cantitate_paleta" value="${perPaleta}">
        <p style="font-size:13px;color:var(--text-muted);margin-top:0">
          Bifate sunt locurile propuse. Debifează ce nu-ți convine — se ocupă doar ce rămâne bifat.
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px">
          ${alese
            .map(
              (grup, i) => `<label style="display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:0">
                <input type="checkbox" name="grup_${i}" value="${grup.map((l) => l.id).join(",")}" checked>
                <span style="font-size:13px">
                  <strong>${grup.map((l) => esc(l.adresa)).join(" + ")}</strong><br>
                  <span style="color:var(--text-muted);font-size:11px">rândul ${grup[0].rand_numar} · nivel ${grup[0].nivel} · câmp ${grup[0].camp}${grup[0].categorie ? " · zonă " + esc(grup[0].categorie) : ""}</span>
                </span>
              </label>`
            )
            .join("")}
        </div>
        ${alese.length ? `<div class="form-actions"><button class="btn" type="submit">Ocupă spațiul și fă etichetele</button></div>` : `<p>Nu e niciun loc liber potrivit. Scoate marfă sau adaugă rânduri.</p>`}
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Locuri propuse", active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/ocupa", async (ctx) => {
    const b = ctx.body;
    const grupuri = Object.keys(b)
      .filter((k) => k.startsWith("grup_"))
      .map((k) => String(b[k]).split(",").map((x) => nr(x)).filter(Boolean))
      .filter((g) => g.length);
    if (!grupuri.length) return redirect(ctx.res, "/stocuri/ct-park/intrare");

    const data = aziStr();

    // Costul cu care intră paleta. Prima variantă e ce a scris omul pe
    // formularul de intrare — ăla vine de pe factura furnizorului. Dacă n-a
    // scris nimic, împrumutăm prețul de achiziție de pe produs și spunem pe
    // paletă de unde e luat, ca nimeni să nu creadă că e prețul ei real.
    let pretPaleta = nr(b.pret_unitar) || null;
    let pretSursa = pretPaleta ? "scris la intrare" : null;
    if (!pretPaleta && nr(b.produs_id)) {
      const pr = await db.prepare("SELECT pret_achizitie FROM produse WHERE id = ?").get(nr(b.produs_id)).catch(() => null);
      const p2 = pr ? nr(pr.pret_achizitie) : 0;
      if (p2 > 0) {
        pretPaleta = p2;
        pretSursa = "preț de achiziție de pe produs";
      }
    }

    const idPaleti = [];
    for (const locuri of grupuri) {
      // Verificăm din nou că locurile sunt libere: între propunere și
      // confirmare poate să fi pus altcineva ceva acolo.
      let libere = true;
      for (const locId of locuri) {
        const ocupat = await db
          .prepare(
            `SELECT 1 AS x FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = ?`
          )
          .get(locId);
        if (ocupat) libere = false;
      }
      if (!libere) continue;

      const r = await db
        .prepare(
          `INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, um, lot, categorie, data_intrare, observatii, creat_de, pret_unitar, pret_sursa${cuFurnizorLaIntrare ? ", furnizor_id, furnizor_text" : ""})
           VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${cuFurnizorLaIntrare ? ", ?, ?" : ""}) RETURNING id`
        )
        .run(
          nr(b.produs_id) || null,
          String(b.produs_text || "").trim() || null,
          nr(b.cantitate_paleta) || null,
          String(b.um || "").trim() || null,
          String(b.lot || "").trim() || null,
          CATEGORII.includes(String(b.categorie || "")) ? String(b.categorie) : null,
          data,
          String(b.observatii || "").trim() || null,
          ctx.user ? ctx.user.nume : null,
          pretPaleta,
          pretSursa,
          ...(cuFurnizorLaIntrare ? [nr(b.furnizor_id) || null, String(b.furnizor_text || "").trim() || null] : [])
        );
      const id = r.lastInsertRowid;
      if (!id) continue;
      await db.prepare("UPDATE ct_paleti SET cod = ? WHERE id = ?").run(codPaleta(id, data), id);
      for (const locId of locuri) await db.prepare("INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (?, ?)").run(id, locId);
      idPaleti.push(id);
    }
    redirect(ctx.res, `/stocuri/ct-park/etichete?paleti=${idPaleti.join(",")}`);
  });

  // ---- Etichetele de 100 × 150 mm ----------------------------------------
  // Pagina se deschide gata de tipărit: formatul hârtiei e fixat din @page,
  // deci nu depinde de ce are omul setat în imprimantă.
  router.get("/stocuri/ct-park/etichete", async (ctx) => {
    const ids = String(ctx.query.paleti || "")
      .split(",")
      .map((x) => nr(x))
      .filter(Boolean);
    if (!ids.length) return redirect(ctx.res, "/stocuri/ct-park/paleti");

    const paleti = await db
      .prepare(
        `SELECT p.*, pr.denumire AS produs, pr.cod AS produs_cod
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.id IN (${ids.map(() => "?").join(",")}) ORDER BY p.id`
      )
      .all(...ids);
    const adrese = await db
      .prepare(
        `SELECT o.palet_id, l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id
          WHERE o.palet_id IN (${ids.map(() => "?").join(",")}) ORDER BY l.camp, l.pozitie`
      )
      .all(...ids);
    const ha = new Map();
    for (const a of adrese) {
      const k = Number(a.palet_id);
      if (!ha.has(k)) ha.set(k, []);
      ha.get(k).push(a.adresa);
    }

    // Dacă paleta a ieșit, eticheta arată ALTCEVA: nu adresa din depozit (care
    // nu mai există), ci unde se duce marfa. Pe comandă apar și clientul, și
    // numărul comenzii, și data ei — astea sunt cerute pe eticheta de livrare.
    const iesiri = await db
      .prepare(`SELECT * FROM ct_iesiri WHERE palet_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC`)
      .all(...ids)
      .catch(() => []);
    const hi = new Map();
    for (const i of iesiri || []) if (!hi.has(Number(i.palet_id))) hi.set(Number(i.palet_id), i);

    const etichete = paleti
      .map((p) => {
        const adr = ha.get(Number(p.id)) || [];
        const ies = hi.get(Number(p.id));
        if (ies) {
          const peComanda = String(ies.destinatie) === "comanda";
          return `<div class="et et-iesire">
            <div class="et-sus">
              <div class="et-firma">CASH MACHINE · IEȘIRE</div>
              <div class="et-data">${esc(ies.data)}</div>
            </div>
            <div class="et-destinatie">${esc(etichetaDestinatie(ies.destinatie))}</div>
            ${peComanda ? `<div class="et-client">${esc(ies.client || "—")}</div>` : ""}
            ${
              peComanda
                ? `<div class="et-comanda">Comanda ${esc(ies.comanda_numar || "—")}${ies.comanda_data ? ` · ${esc(ies.comanda_data)}` : ""}</div>`
                : ""
            }
            <div class="et-produs">${esc(p.produs || p.produs_text || "—")}</div>
            <div class="et-cod">${esc(p.produs_cod || "")}</div>
            <table class="et-tab">
              <tr><td>Cantitate</td><td><strong>${nr(p.cantitate) ? nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "") : "—"}</strong></td></tr>
              <tr><td>Lot</td><td>${esc(p.lot || "—")}</td></tr>
              <tr><td>A plecat din</td><td>${esc(ies.adresa || "—")}</td></tr>
              <tr><td>Scoasă de</td><td>${esc(ies.creat_de || "—")}</td></tr>
            </table>
            ${ies.observatii ? `<div class="et-obs">${esc(ies.observatii)}</div>` : ""}
            <div class="et-jos">${esc(p.cod)}</div>
          </div>`;
        }
        return `<div class="et">
          <div class="et-sus">
            <div class="et-firma">CASH MACHINE · CT-PARK</div>
            <div class="et-data">${esc(p.data_intrare)}</div>
          </div>
          <div class="et-adresa">${esc(adr[0] || "—")}</div>
          ${adr.length > 1 ? `<div class="et-adrese-plus">+ ${adr.slice(1).map((a) => esc(a)).join(" + ")}</div>` : ""}
          <div class="et-produs">${esc(p.produs || p.produs_text || "—")}</div>
          <div class="et-cod">${esc(p.produs_cod || "")}</div>
          <table class="et-tab">
            <tr><td>Cantitate</td><td><strong>${nr(p.cantitate) ? nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "") : "—"}</strong></td></tr>
            <tr><td>Lot</td><td>${esc(p.lot || "—")}</td></tr>
            <tr><td>Categorie</td><td>${esc(p.categorie || "—")}</td></tr>
            <tr><td>Locuri</td><td>${adr.length}</td></tr>
          </table>
          <div class="et-jos">${esc(p.cod)}</div>
        </div>`;
      })
      .join("");

    const html = `<!doctype html><html lang="ro"><head><meta charset="utf-8">
      <title>Etichete CT-Park (${paleti.length})</title>
      <style>
        @page { size: 100mm 150mm; margin: 0; }
        * { box-sizing: border-box; }
        body { margin:0; font-family: system-ui, "Segoe UI", Arial, sans-serif; background:#eceff3; }
        .et { width:100mm; height:150mm; padding:6mm; background:#fff; page-break-after:always; break-after:page;
              display:flex; flex-direction:column; margin:0 auto 8mm; border:1px solid #ccc; }
        .et-sus { display:flex; justify-content:space-between; font-size:9pt; letter-spacing:.04em; border-bottom:1.5pt solid #000; padding-bottom:2mm; }
        .et-firma { font-weight:700; }
        .et-adresa { font-size:38pt; font-weight:800; letter-spacing:-.01em; text-align:center; margin:5mm 0 0; font-family:"Consolas","DejaVu Sans Mono",monospace; }
        .et-adrese-plus { text-align:center; font-size:11pt; color:#444; margin-top:1mm; font-family:"Consolas","DejaVu Sans Mono",monospace; }
        .et-produs { font-size:14pt; font-weight:600; margin-top:6mm; line-height:1.15; }
        .et-cod { font-size:11pt; color:#444; font-family:"Consolas","DejaVu Sans Mono",monospace; margin-top:1mm; }
        .et-tab { width:100%; margin-top:4mm; border-collapse:collapse; font-size:11pt; }
        .et-tab td { padding:1.5mm 0; border-bottom:.5pt solid #ddd; }
        .et-tab td:first-child { color:#555; width:38%; }
        .et-iesire .et-sus { border-bottom-color:#b3261e; }
        .et-destinatie { font-size:30pt; font-weight:800; text-align:center; margin:6mm 0 0; text-transform:uppercase; letter-spacing:.02em; }
        .et-client { font-size:16pt; font-weight:700; text-align:center; margin-top:3mm; line-height:1.15; }
        .et-comanda { font-size:12pt; text-align:center; color:#333; margin-top:1mm; font-family:"Consolas","DejaVu Sans Mono",monospace; }
        .et-obs { font-size:10pt; color:#444; margin-top:3mm; }
        .et-jos { margin-top:auto; text-align:center; font-size:13pt; font-weight:700; letter-spacing:.08em;
                  font-family:"Consolas","DejaVu Sans Mono",monospace; border-top:1.5pt solid #000; padding-top:2mm; }
        .bara { text-align:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-family:system-ui,sans-serif; }
        @media print { .bara { display:none; } .et { border:0; margin:0; } body { background:#fff; } }
      </style></head><body>
      <div class="bara">
        <strong>${paleti.length} etichet${paleti.length === 1 ? "ă" : "e"}</strong> de 100 × 150 mm${
          [...hi.keys()].length ? " · ieșire" : ""
        } —
        <button onclick="window.print()">Tipărește</button>
        <a href="/stocuri/ct-park">înapoi la depozit</a>
      </div>
      ${etichete}
      </body></html>`;
    // Pagina de etichete isi face singura HTML-ul, deci nu trece prin layout:
    // ii traducem datele la fel ca peste tot.
    send(ctx.res, 200, dateleInText(html));
  });

  // ---- Configurarea rândurilor -------------------------------------------
  router.get("/stocuri/ct-park/configurare", async (ctx) => {
    const randuri = await sumarRanduri();
    const existente = new Set(randuri.map((r) => Number(r.numar)));
    const dinPlan = GRUPURI.flat().sort((a, b) => a - b);

    const body = `
      ${subtabs("/stocuri/ct-park/configurare")}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Configurare rânduri</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:820px">
        Câte câmpuri și câte niveluri are fiecare rând. Din cifrele astea se nasc adresele de palet — de-aia,
        dacă schimbi numărul de câmpuri sau de niveluri, locurile se regenerează. Locurile pe care stă marfă
        <strong>nu se șterg</strong>: dacă ai reduce rândul sub ele, salvarea se oprește și îți spune care.
        Butoanele <strong>+</strong> și <strong>−</strong> de pe coloana „Niveluri" adaugă un nivel deasupra sau îl
        scot pe cel de sus, dintr-un click. Intră pe rând ca să dai fiecărui nivel înălțimea și numărul lui de paleți.
      </p>

      ${
        randuri.length
          ? table(
              ["Rând", "Etichetă", "Câmpuri", "Niveluri", "Paleți / câmp", "Locuri", "Ocupate", ""],
              randuri.map((r) => [
                `<a href="/stocuri/ct-park/rand/${r.id}"><strong>${r.numar}</strong></a>`,
                pastila(r.eticheta) || "—",
                String(r.campuri),
                butoaneNivel(r, ""),
                String(r.locuri_pe_camp),
                String(r.locuri),
                String(r.ocupate),
                `<a class="btn small secondary" href="/stocuri/ct-park/configurare/${r.id}">Editează</a>`,
              ])
            )
          : ""
      }

      <details class="detail-box" style="margin-top:16px"${randuri.length ? "" : " open"}>
        <summary style="cursor:pointer;font-weight:600">+ Rând nou</summary>
        <form class="form" method="post" action="/stocuri/ct-park/configurare" style="max-width:900px;margin-top:12px">
          <div style="display:grid;grid-template-columns:1fr 2fr 1fr 1fr 1fr;gap:14px">
            <label class="field">Numărul rândului<input type="number" name="numar" min="1" max="99" required></label>
            <label class="field">Ce ține rândul
              <select name="eticheta"><option value="">—</option>${CATEGORII.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
            </label>
            <label class="field">Câmpuri<input type="number" name="campuri" min="1" max="60" value="10" required></label>
            <label class="field">Niveluri<input type="number" name="niveluri" min="1" max="12" value="4" required></label>
            <label class="field">Paleți / câmp<input type="number" name="locuri_pe_camp" min="1" max="6" value="3" required></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
            <label class="field">Lățime loc (mm)<input type="number" name="latime_loc" min="100" value="900"></label>
            <label class="field">Adâncime loc (mm)<input type="number" name="adancime_loc" min="100" value="${ADANCIME}"></label>
            <label class="field">Înălțime nivel (mm)<input type="number" name="inaltime_nivel" min="100" value="1800"></label>
          </div>
          <div class="form-actions"><button class="btn" type="submit">Adaugă rândul</button></div>
        </form>
      </details>

      ${
        dinPlan.some((n) => !existente.has(n))
          ? `<form method="post" action="/stocuri/ct-park/configurare/din-plan" class="detail-box" style="margin-top:14px;max-width:760px">
              <strong>Ia rândurile din planul de montaj</strong>
              <p style="font-size:13px;color:var(--text-muted);margin:6px 0 10px">
                Planul are ${dinPlan.length} rânduri (${dinPlan.join(", ")}), din care ${dinPlan.filter((n) => !existente.has(n)).length} încă nu sunt configurate.
                Le creează pe toate cu aceleași cifre, pe care le poți schimba pe fiecare după aceea.
              </p>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;max-width:520px">
                <label class="field">Câmpuri<input type="number" name="campuri" min="1" max="60" value="10"></label>
                <label class="field">Niveluri<input type="number" name="niveluri" min="1" max="12" value="4"></label>
                <label class="field">Paleți / câmp<input type="number" name="locuri_pe_camp" min="1" max="6" value="3"></label>
              </div>
              <div class="form-actions"><button class="btn" type="submit">Creează rândurile lipsă</button></div>
            </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Configurare CT-Park", active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/configurare", async (ctx) => {
    const b = ctx.body;
    const numar = Math.round(nr(b.numar));
    if (!numar) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const existent = await db.prepare("SELECT id FROM ct_randuri WHERE numar = ?").get(numar);
    if (existent) return redirect(ctx.res, `/stocuri/ct-park/configurare/${existent.id}`);
    const r = await db
      .prepare(
        `INSERT INTO ct_randuri (numar, eticheta, niveluri, campuri, locuri_pe_camp, latime_loc, adancime_loc, inaltime_nivel, activ)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`
      )
      .run(
        numar,
        CATEGORII.includes(String(b.eticheta || "")) ? String(b.eticheta) : null,
        Math.max(1, Math.round(nr(b.niveluri) || 4)),
        Math.max(1, Math.round(nr(b.campuri) || 10)),
        Math.max(1, Math.round(nr(b.locuri_pe_camp) || 3)),
        Math.round(nr(b.latime_loc) || 900),
        Math.round(nr(b.adancime_loc) || ADANCIME),
        Math.round(nr(b.inaltime_nivel) || 1800)
      );
    if (r.lastInsertRowid) await regenereazaLocuri(r.lastInsertRowid);
    redirect(ctx.res, "/stocuri/ct-park/configurare");
  });

  router.post("/stocuri/ct-park/configurare/din-plan", async (ctx) => {
    const b = ctx.body;
    const campuri = Math.max(1, Math.round(nr(b.campuri) || 10));
    const niveluri = Math.max(1, Math.round(nr(b.niveluri) || 4));
    const perCamp = Math.max(1, Math.round(nr(b.locuri_pe_camp) || 3));
    for (const numar of GRUPURI.flat().sort((a, c) => a - c)) {
      const existent = await db.prepare("SELECT id FROM ct_randuri WHERE numar = ?").get(numar);
      if (existent) continue;
      const r = await db
        .prepare(
          `INSERT INTO ct_randuri (numar, niveluri, campuri, locuri_pe_camp, latime_loc, adancime_loc, inaltime_nivel, activ)
           VALUES (?, ?, ?, ?, 900, ?, 1800, 1) RETURNING id`
        )
        .run(numar, niveluri, campuri, perCamp, ADANCIME);
      if (r.lastInsertRowid) await regenereazaLocuri(r.lastInsertRowid);
    }
    redirect(ctx.res, "/stocuri/ct-park/configurare");
  });

  // ---- Un nivel în plus sau în minus, dintr-un click ----------------------
  // E cea mai obișnuită schimbare la un depozit care încă se așază, și n-are
  // rost să treacă de fiecare dată prin formularul mare. Se adaugă mereu
  // DEASUPRA, se scoate mereu de sus — așa adresele de jos rămân valabile și
  // etichetele lipite pe raft nu trebuie retipărite.
  router.post("/stocuri/ct-park/configurare/:id/nivel", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const inapoi =
      String(ctx.body.inapoi || "") === "rand"
        ? `/stocuri/ct-park/rand/${r.id}`
        : `/stocuri/ct-park/configurare/${r.id}`;
    const spune = (cheie, text) => redirect(ctx.res, `${inapoi}?${cheie}=${encodeURIComponent(text)}`);
    const acum = nr(r.niveluri);

    if (String(ctx.body.spre || "adauga") !== "scoate") {
      if (acum >= 12) return spune("eroare", "Rândul are deja 12 niveluri — mai sus nu se poate.");
      await db.prepare("UPDATE ct_randuri SET niveluri = ? WHERE id = ?").run(acum + 1, r.id);
      await regenereazaLocuri(r.id);
      return spune("ok", `Nivelul ${acum + 1} a fost adăugat deasupra.`);
    }

    if (acum <= 1) return spune("eroare", "Rândul are un singur nivel, n-am ce scoate.");
    // Butonul schimbă cifra RÂNDULUI, adică numai câmpurile fără porțiune
    // proprie. Un câmp dintr-un sector de 5 niveluri rămâne de 5 — de-aia
    // verificarea se face pe harta de după, nu pe un singur număr.
    const sect = await sectoareRand(r.id);
    const viitor = nivelurilePeCamp({ ...r, niveluri: acum - 1 }, sect, nr(r.campuri));
    const niv = await niveluriRand(r, Math.max(acum - 1, ...sect.map((s) => s.niveluri || 0), 1));
    const h = new Map(niv.map((n) => [n.nivel, n.locuri]));
    const afara = await locuriInAfara(
      r.id,
      nr(r.campuri),
      (c) => viitor.get(c) || 0,
      locuriLaViitor(r, sect, nr(r.campuri), (n) => h.get(n) || nr(r.locuri_pe_camp))
    );
    if (afara.length) {
      return spune(
        "eroare",
        `Nu pot scoate nivelul ${acum}: pe ${afara.slice(0, 8).map((a) => a.adresa).join(", ")}${afara.length > 8 ? "…" : ""} stă marfă. Scoate-o întâi din depozit.`
      );
    }
    await db.prepare("UPDATE ct_randuri SET niveluri = ? WHERE id = ?").run(acum - 1, r.id);
    try {
      await db.prepare("DELETE FROM ct_niveluri WHERE rand_id = ? AND nivel > ?").run(r.id, acum - 1);
    } catch (e) {
      /* tabelul poate lipsi pe o bază veche — nivelurile rămân cele ale rândului */
    }
    await regenereazaLocuri(r.id);
    return spune("ok", `Nivelul ${acum} a fost scos.`);
  });

  // ---- Configurația fiecărui nivel în parte -------------------------------
  // Înălțimea și numărul de paleți se scriu pe nivel, nu pe rând: jos stau
  // paleți înalți, sus cutii. Un nivel lăsat gol moștenește cifrele rândului,
  // deci se scrie doar ce chiar e altfel.
  router.post("/stocuri/ct-park/configurare/:id/niveluri", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const b = ctx.body || {};
    const inapoi = `/stocuri/ct-park/configurare/${r.id}`;

    // Până la ce nivel merge formularul: nu până la cifra rândului, ci până
    // la vârful lui real. Un sector de 5 niveluri pe un rând declarat de 3
    // are nivelurile 4 și 5 în tabel, și ele trebuie să se poată configura.
    const plan = await planRand(r);
    const varf = plan.varf;

    // Întâi verificăm că nicio micșorare nu taie raftul de sub o paletă.
    const dorite = new Map();
    for (let i = 1; i <= varf; i++) {
      const locuri = Math.max(1, Math.min(6, Math.round(nr(b[`n${i}_locuri`]) || nr(r.locuri_pe_camp))));
      dorite.set(i, locuri);
    }
    const afara = await locuriInAfara(
      r.id,
      nr(r.campuri),
      (c) => plan.peCamp.get(c) || 0,
      // Un câmp care are lățimea scrisă în sectorul lui nu se îngustează de
      // aici: cifra nivelului e pentru câmpurile fără porțiune proprie.
      locuriLaViitor(r, plan.sectoare, nr(r.campuri), (n) => dorite.get(n) || nr(r.locuri_pe_camp))
    );
    if (afara.length) {
      const mesaj = `Nu pot îngusta nivelurile: pe ${afara.slice(0, 8).map((a) => a.adresa).join(", ")}${afara.length > 8 ? "…" : ""} stă marfă.`;
      return redirect(ctx.res, `${inapoi}?eroare=${encodeURIComponent(mesaj)}`);
    }

    for (let i = 1; i <= varf; i++) {
      const inaltime = Math.round(nr(b[`n${i}_inaltime`]));
      const eticheta = String(b[`n${i}_eticheta`] || "").trim().slice(0, 60) || null;
      const locuri = dorite.get(i);
      // Un nivel care nu se abate de la rând nu ține rând în tabel.
      const identic = (!inaltime || inaltime === nr(r.inaltime_nivel)) && !eticheta && locuri === nr(r.locuri_pe_camp);
      try {
        await db.prepare("DELETE FROM ct_niveluri WHERE rand_id = ? AND nivel = ?").run(r.id, i);
        if (!identic) {
          await db
            .prepare("INSERT INTO ct_niveluri (rand_id, nivel, inaltime, eticheta, locuri_pe_camp) VALUES (?, ?, ?, ?, ?)")
            .run(r.id, i, inaltime || null, eticheta, locuri);
        }
      } catch (e) {
        /* tabelul lipsește pe o bază veche — se salvează la următoarea pornire */
      }
    }
    await regenereazaLocuri(r.id);
    redirect(ctx.res, `${inapoi}?ok=${encodeURIComponent("Nivelurile au fost salvate.")}`);
  });

  // ---- Editarea raftului cu degetul, de pe desen --------------------------
  //
  // „Fa sa pot configura si de aici sa sterg spre exemplu spatii si sa se
  // salveze automat configuratia sau sa adaug, mai exact sa activez inca o
  // coloana sau interval."
  //
  // Formularul de porțiuni e bun când știi dinainte ce vrei. Când te uiți la
  // raft și vezi că al treilea câmp are două locuri, nu trei, vrei să apeși
  // acolo, nu să numeri câmpurile și să scrii un interval.
  //
  // Ruta asta ia o singură schimbare și o salvează pe loc. Răspunde JSON, ca
  // pagina să poată spune ce s-a întâmplat fără să se reîncarce; dacă JS-ul
  // nu merge, formularul mare face același lucru, deci nu se pierde nimic.
  //
  // Ce poate face:
  //   camp     — câte niveluri / câți paleți are UN câmp (scrie un sector
  //              de un singur câmp, ca omul să nu scrie intervale)
  //   interval — același lucru, pe mai multe câmpuri deodată
  //   loc      — scoate din uz sau repune în uz UN loc anume
  //   adauga   — încă un câmp la capătul rândului
  //   scoate   — câmpul de la capăt, dacă e gol
  router.post("/stocuri/ct-park/rand/:id/editeaza", async (ctx) => {
    const raspunde = (cod, obj) => send(ctx.res, cod, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return raspunde(404, { ok: false, mesaj: "Rândul nu există." });
    const b = ctx.body || {};
    const ce = String(b.ce || "");
    const campuri = nr(r.campuri);

    // Un loc scos din uz: „sterg spatii". Nu se șterge rândul din tabel —
    // se marchează blocat, ca adresa să rămână a lui și eticheta lipită pe
    // raft să nu mintă. Se poate repune oricând.
    if (ce === "loc") {
      const l = await db.prepare("SELECT * FROM ct_locuri WHERE id = ? AND rand_id = ?").get(b.loc, r.id);
      if (!l) return raspunde(404, { ok: false, mesaj: "Locul nu e în rândul ăsta." });
      const ocupat = await db
        .prepare(
          `SELECT 1 AS da FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = ?`
        )
        .get(l.id);
      if (ocupat && !nr(l.blocat)) return raspunde(409, { ok: false, mesaj: `Pe ${l.adresa} stă marfă. Scoate-o întâi.` });
      const nou = nr(l.blocat) ? 0 : 1;
      await db.prepare("UPDATE ct_locuri SET blocat = ? WHERE id = ?").run(nou, l.id);
      return raspunde(200, { ok: true, mesaj: nou ? `${l.adresa} e scos din uz.` : `${l.adresa} e iar în uz.`, reincarca: true });
    }

    if (ce === "adauga" || ce === "scoate") {
      const nouCampuri = ce === "adauga" ? campuri + 1 : campuri - 1;
      if (nouCampuri < 1) return raspunde(400, { ok: false, mesaj: "Rândul are un singur câmp, n-am ce scoate." });
      if (nouCampuri > 60) return raspunde(400, { ok: false, mesaj: "Un rând poate avea cel mult 60 de câmpuri." });
      if (ce === "scoate") {
        const sect = await sectoareRand(r.id);
        const viitor = nivelurilePeCamp(r, sect, nouCampuri);
        const nivv = await niveluriRand(r, Math.max(nr(r.niveluri), ...sect.map((s) => s.niveluri || 0), 1));
        const hl = new Map(nivv.map((n) => [n.nivel, n.locuri]));
        const afara = await locuriInAfara(r.id, nouCampuri, (c) => viitor.get(c) || 0, locuriLaViitor(r, sect, nouCampuri, (n) => hl.get(n) || nr(r.locuri_pe_camp)));
        if (afara.length) return raspunde(409, { ok: false, mesaj: `Pe câmpul ${campuri} stă marfă (${afara.slice(0, 3).map((a) => a.adresa).join(", ")}). Scoate-o întâi.` });
      }
      await db.prepare("UPDATE ct_randuri SET campuri = ? WHERE id = ?").run(nouCampuri, r.id);
      // Porțiunile care ies complet din rând se curăță, ca să nu rămână
      // scrise undeva unde nu mai e nimic.
      try {
        await db.prepare("DELETE FROM ct_sectoare WHERE rand_id = ? AND camp_de_la > ?").run(r.id, nouCampuri);
        await db.prepare("UPDATE ct_sectoare SET camp_pana_la = ? WHERE rand_id = ? AND camp_pana_la > ?").run(nouCampuri, r.id, nouCampuri);
      } catch (e) {
        /* bază veche fără tabelul de porțiuni */
      }
      await regenereazaLocuri(r.id);
      return raspunde(200, { ok: true, mesaj: ce === "adauga" ? `Câmpul ${nouCampuri} a fost activat.` : `Câmpul ${campuri} a fost scos.`, reincarca: true });
    }

    if (ce !== "camp" && ce !== "interval") return raspunde(400, { ok: false, mesaj: "Nu știu ce să fac." });

    const deLa = Math.round(nr(ce === "camp" ? b.camp : b.de_la));
    const panaLa = Math.round(nr(ce === "camp" ? b.camp : b.pana_la));
    if (!deLa || !panaLa || deLa < 1 || panaLa > campuri || panaLa < deLa)
      return raspunde(400, { ok: false, mesaj: `Rândul are ${campuri} câmpuri; ${deLa}–${panaLa} nu e un interval bun.` });

    // Ce are câmpul ACUM, ca să schimbăm doar ce s-a cerut.
    const plan = await planRand(r);
    const nivAcum = plan.peCamp.get(deLa) || nr(r.niveluri);
    const palAcum = plan.locuriLa(deLa, 1);
    const niv = b.niveluri === undefined || b.niveluri === "" ? nivAcum : Math.round(nr(b.niveluri));
    const pal = b.paleti === undefined || b.paleti === "" ? palAcum : Math.round(nr(b.paleti));
    if (niv < 1 || niv > NIVEL_MAX) return raspunde(400, { ok: false, mesaj: `Între 1 și ${NIVEL_MAX} niveluri.` });
    if (pal < 1 || pal > PALETI_MAX) return raspunde(400, { ok: false, mesaj: `Între 1 și ${PALETI_MAX} paleți pe câmp.` });

    // Porțiunile de după schimbare: scoatem câmpurile atinse din toate
    // porțiunile existente și punem una nouă peste ele. Așa două apăsări pe
    // același câmp nu lasă în urmă un morman de intervale suprapuse.
    const vechi = await sectoareRand(r.id);
    const ramase = [];
    for (const s of vechi) {
      // Bucata dinainte și bucata de după intervalul atins.
      if (s.de_la < deLa) ramase.push({ ...s, pana_la: Math.min(s.pana_la, deLa - 1) });
      if (s.pana_la > panaLa) ramase.push({ ...s, de_la: Math.max(s.de_la, panaLa + 1) });
    }
    const nouSector = {
      de_la: deLa,
      pana_la: panaLa,
      niveluri: niv === nr(r.niveluri) ? null : niv,
      locuri: pal === nr(r.locuri_pe_camp) ? null : pal,
    };
    const dorite = ramase.filter((s) => s.pana_la >= s.de_la && (s.niveluri !== null || s.locuri !== null));
    // Un câmp care a ajuns exact pe cifrele rândului nu mai are nevoie de
    // porțiune: o lăsăm să dispară, ca lista să rămână scurtă și citibilă.
    if (nouSector.niveluri !== null || nouSector.locuri !== null) dorite.push(nouSector);
    dorite.sort((a, c) => a.de_la - c.de_la || a.pana_la - c.pana_la);

    const viitor = nivelurilePeCamp(r, dorite, campuri);
    const varf = Math.max(nr(r.niveluri), ...dorite.map((s) => s.niveluri || 0), 1);
    const nivv = await niveluriRand(r, varf);
    const hl = new Map(nivv.map((n) => [n.nivel, n.locuri]));
    const afara = await locuriInAfara(r.id, campuri, (c) => viitor.get(c) || 0, locuriLaViitor(r, dorite, campuri, (n) => hl.get(n) || nr(r.locuri_pe_camp)));
    if (afara.length)
      return raspunde(409, {
        ok: false,
        mesaj: `Nu pot: pe ${afara.slice(0, 5).map((a) => a.adresa).join(", ")}${afara.length > 5 ? "…" : ""} stă marfă.`,
      });

    try {
      await db.prepare("DELETE FROM ct_sectoare WHERE rand_id = ?").run(r.id);
      for (const s of dorite) {
        await db
          .prepare("INSERT INTO ct_sectoare (rand_id, camp_de_la, camp_pana_la, niveluri, locuri_pe_camp) VALUES (?, ?, ?, ?, ?)")
          .run(r.id, s.de_la, s.pana_la, s.niveluri, s.locuri);
      }
    } catch (e) {
      return raspunde(500, { ok: false, mesaj: "Tabelul de porțiuni nu există în bază. Repornește aplicația." });
    }
    await regenereazaLocuri(r.id);
    const dupa = await planRand(r);
    const unde = deLa === panaLa ? `Câmpul ${deLa}` : `Câmpurile ${deLa}–${panaLa}`;
    return raspunde(200, {
      ok: true,
      mesaj: `${unde}: ${niv} ${niv === 1 ? "nivel" : "niveluri"} × ${pal} ${pal === 1 ? "palet" : "paleți"}. ${dupa.locuri} locuri în rând.`,
      reincarca: true,
    });
  });

  // ---- Porțiuni de rând cu alt număr de niveluri --------------------------
  // „Trebuie sa pot configura pe acelasi rand si 3 si 2 si 5 si 1 nivel pe
  // orice interval adica nu sunt toate de 3."
  //
  // Se salvează toate deodată și se înlocuiesc cele vechi: formularul e
  // adevărul, nu un adaos peste el. Un rând golit dispare, așa se șterge o
  // porțiune. Ca peste tot în CT-Park, nu se taie raftul de sub marfă —
  // dacă o porțiune ar coborî sub o paletă, nu se salvează nimic și se
  // spune care paletă stă în drum.
  router.post("/stocuri/ct-park/configurare/:id/sectoare", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const b = ctx.body || {};
    const inapoi = `/stocuri/ct-park/configurare/${r.id}`;
    const spune = (cheie, text) => redirect(ctx.res, `${inapoi}?${cheie}=${encodeURIComponent(text)}`);
    const campuri = nr(r.campuri);

    const dorite = [];
    for (let i = 0; i < 40; i++) {
      const deLa = Math.round(nr(b[`s${i}_de_la`]));
      const panaLa = Math.round(nr(b[`s${i}_pana_la`]));
      const niv = Math.round(nr(b[`s${i}_niveluri`]));
      const pal = Math.round(nr(b[`s${i}_paleti`]));
      // Rând complet gol = rând șters. Interval fără nicio cifră = rând care
      // n-ar spune nimic. Jumătate de interval = greșeală de tastare, și e
      // mai bine să i se spună decât să fie înghițită.
      if (!deLa && !panaLa && !niv && !pal) continue;
      if (!deLa || !panaLa) return spune("eroare", `Porțiunea ${i + 1} e incompletă: completează și de la ce câmp, și până la ce câmp.`);
      if (!niv && !pal) return spune("eroare", `Porțiunea ${deLa}–${panaLa} nu schimbă nimic: scrie câte niveluri are, câți paleți intră într-un câmp, sau amândouă.`);
      if (deLa < 1 || panaLa > campuri) return spune("eroare", `Rândul are ${campuri} câmpuri, iar porțiunea ${deLa}–${panaLa} iese din el.`);
      if (panaLa < deLa) return spune("eroare", `Porțiunea ${deLa}–${panaLa} e scrisă invers: „până la" trebuie să fie cel puțin cât „de la".`);
      if (niv && (niv < 1 || niv > NIVEL_MAX)) return spune("eroare", `Un rând poate avea între 1 și ${NIVEL_MAX} niveluri, nu ${niv}.`);
      if (pal && (pal < 1 || pal > PALETI_MAX)) return spune("eroare", `Într-un câmp intră între 1 și ${PALETI_MAX} paleți, nu ${pal}.`);
      dorite.push({ de_la: deLa, pana_la: panaLa, niveluri: niv || null, locuri: pal || null });
    }
    dorite.sort((a, c) => a.de_la - c.de_la || a.pana_la - c.pana_la);

    // Verificăm pe configurația VIITOARE, nu pe cea de acum.
    const viitor = nivelurilePeCamp(r, dorite, campuri);
    const varf = Math.max(nr(r.niveluri), ...dorite.map((s) => s.niveluri || 0), 1);
    const niv = await niveluriRand(r, varf);
    const hLocuri = new Map(niv.map((n) => [n.nivel, n.locuri]));
    const afara = await locuriInAfara(
      r.id,
      campuri,
      (camp) => viitor.get(camp) || 0,
      locuriLaViitor(r, dorite, campuri, (n) => hLocuri.get(n) || nr(r.locuri_pe_camp))
    );
    if (afara.length) {
      return spune(
        "eroare",
        `Nu pot scurta rândul: pe ${afara.slice(0, 8).map((a) => a.adresa).join(", ")}${afara.length > 8 ? "…" : ""} stă marfă. Scoate-o întâi din depozit.`
      );
    }

    try {
      await db.prepare("DELETE FROM ct_sectoare WHERE rand_id = ?").run(r.id);
      for (const s of dorite) {
        await db
          .prepare("INSERT INTO ct_sectoare (rand_id, camp_de_la, camp_pana_la, niveluri, locuri_pe_camp) VALUES (?, ?, ?, ?, ?)")
          .run(r.id, s.de_la, s.pana_la, s.niveluri, s.locuri);
      }
    } catch (e) {
      return spune("eroare", "Tabelul de porțiuni încă nu există în bază. Repornește aplicația și încearcă din nou.");
    }
    await regenereazaLocuri(r.id);
    const dupa = await planRand(r);
    return spune(
      "ok",
      dorite.length
        ? `Salvat: câmpurile ${bucatiRand(dupa.peCamp, campuri, dupa.locuriLa)
            .map((x) => `${x.de_la === x.pana_la ? x.de_la : x.de_la + "–" + x.pana_la} cu ${x.niveluri} niv. × ${x.paleti} pal.`)
            .join(", ")}. ${dupa.locuri} locuri în rând.`
        : `Porțiunile au fost șterse — tot rândul are acum ${nr(r.niveluri)} niveluri și ${nr(r.locuri_pe_camp)} paleți pe câmp, ${dupa.locuri} locuri.`
    );
  });

  router.get("/stocuri/ct-park/configurare/:id", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const ocupate = await db
      .prepare(
        `SELECT l.adresa, l.nivel, l.camp, l.pozitie FROM ct_locuri l
           JOIN ct_ocupari o ON o.loc_id = l.id JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
          WHERE l.rand_id = ? ORDER BY l.nivel DESC, l.camp`
      )
      .all(r.id);
    const plan = await planRand(r);
    const niveluri = plan.niveluri;
    const ocupatePeNivel = new Map();
    for (const o of ocupate) ocupatePeNivel.set(nr(o.nivel), (ocupatePeNivel.get(nr(o.nivel)) || 0) + 1);

    // Sectoarele salvate, plus trei rânduri goale de adăugat. Se salvează
    // toate deodată, iar un rând golit înseamnă „șterge-l" — un buton de
    // ștergere pe fiecare rând ar fi fost încă patru rute și tot atâtea
    // confirmări, pentru ceva ce se face o dată la montarea raftului.
    const randuriSector = [...plan.sectoare.map((s) => ({ ...s })), {}, {}, {}].slice(0, Math.max(6, plan.sectoare.length + 3));
    const formSectoare = randuriSector
      .map(
        (s, i) => `<tr>
          <td><input class="ct-in" style="width:80px" type="number" name="s${i}_de_la" min="1" max="${nr(r.campuri)}" value="${s.de_la || ""}" placeholder="de la"></td>
          <td><input class="ct-in" style="width:80px" type="number" name="s${i}_pana_la" min="1" max="${nr(r.campuri)}" value="${s.pana_la || ""}" placeholder="până la"></td>
          <td><input class="ct-in" style="width:80px" type="number" name="s${i}_niveluri" min="1" max="${NIVEL_MAX}" value="${s.niveluri || ""}" placeholder="ca rândul"></td>
          <td><input class="ct-in" style="width:80px" type="number" name="s${i}_paleti" min="1" max="${PALETI_MAX}" value="${s.locuri || ""}" placeholder="ca rândul"></td>
        </tr>`
      )
      .join("");

    const body = `
      ${subtabs("/stocuri/ct-park/configurare")}
      <div class="toolbar"><a class="btn secondary" href="/stocuri/ct-park/configurare">← Toate rândurile</a>
        <a class="btn secondary" href="/stocuri/ct-park/rand/${r.id}">Vezi fața rândului</a></div>
      ${mesaje(ctx.query)}
      <form class="form" method="post" action="/stocuri/ct-park/configurare/${r.id}" style="max-width:900px">
        <h1 style="margin-top:0">Rândul ${r.numar}</h1>
        <div style="display:grid;grid-template-columns:1fr 2fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Număr<input type="number" name="numar" min="1" max="99" value="${r.numar}" required></label>
          <label class="field">Ce ține rândul
            <select name="eticheta"><option value="">—</option>${CATEGORII.map((c) => `<option value="${esc(c)}"${r.eticheta === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
          </label>
          <label class="field">Câmpuri<input type="number" name="campuri" min="1" max="60" value="${r.campuri}" required></label>
          <label class="field">Niveluri<input type="number" name="niveluri" min="1" max="12" value="${r.niveluri}" required></label>
          <label class="field">Paleți / câmp<input type="number" name="locuri_pe_camp" min="1" max="6" value="${r.locuri_pe_camp}" required></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Lățime loc (mm)<input type="number" name="latime_loc" min="100" value="${r.latime_loc}"></label>
          <label class="field">Adâncime loc (mm)<input type="number" name="adancime_loc" min="100" value="${r.adancime_loc}"></label>
          <label class="field">Înălțime nivel (mm)<input type="number" name="inaltime_nivel" min="100" value="${r.inaltime_nivel}"></label>
          <label class="field">Stare<select name="activ"><option value="1"${Number(r.activ) === 1 ? " selected" : ""}>în folosință</option><option value="0"${Number(r.activ) === 0 ? " selected" : ""}>scos din uz</option></select></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted);max-width:860px;margin-bottom:4px">
        „Paleți / câmp" și „Înălțime nivel" de mai sus sunt <strong>valorile implicite ale rândului</strong>.
        Nivelurile care au cifra lor, din tabelul de jos, o folosesc pe a lor — restul o iau de aici.
      </p>
      <p style="font-size:12px;color:var(--text-muted);max-width:760px">
        ${ocupate.length ? `Pe rândul ăsta stau ${ocupate.length} paleți: ${ocupate.slice(0, 12).map((o) => esc(o.adresa)).join(", ")}${ocupate.length > 12 ? "…" : ""}. Nu poți micșora rândul sub ei.` : "Rândul e gol, îl poți redimensiona liber."}
      </p>

      <h2 style="margin-top:22px">Nivelurile rândului</h2>
      <p style="font-size:13px;color:var(--text-muted);max-width:860px;margin:0 0 10px">
        Aici se face designul de stocare: fiecare nivel cu înălțimea lui și cu câți paleți intră pe un câmp.
        Nivelul de jos poate ține paleți de 2,2 m, iar cel de sus cutii de 1 m — nu trebuie să fie toate la fel.
        Un câmp lăsat gol moștenește cifra rândului. <strong>Nivelul 1 e cel de jos.</strong>
        Înălțimea totală a rândului acum: <strong>${(inaltimeRand(niveluri) / 1000).toFixed(2)} m</strong>
        (nivelurile plus ${GRINDA} mm de grindă sub fiecare).
      </p>
      <div class="ct-niv-butoane">
        ${butoaneNivel(r, "")}
        <span style="font-size:12px;color:var(--text-muted)">adaugă un nivel deasupra sau scoate-l pe cel de sus</span>
      </div>
      <form class="form" method="post" action="/stocuri/ct-park/configurare/${r.id}/niveluri" style="max-width:900px">
        <table class="table" style="margin-bottom:10px">
          <thead><tr><th>Nivel</th><th>Înălțime utilă (mm)</th><th>Paleți / câmp</th><th>La ce e</th><th>Locuri</th><th>Ocupate</th></tr></thead>
          <tbody>
            ${niveluri
              .slice()
              .reverse()
              .map(
                (n) => `<tr>
                  <td><strong>N${n.nivel}</strong>${n.nivel === 1 ? ' <span style="font-size:11px;color:var(--text-muted)">jos</span>' : ""}${n.nivel === niveluri.length && niveluri.length > 1 ? ' <span style="font-size:11px;color:var(--text-muted)">sus</span>' : ""}</td>
                  <td><input class="ct-in" type="number" name="n${n.nivel}_inaltime" min="100" max="6000" step="10" value="${n.inaltime}"></td>
                  <td><input class="ct-in" type="number" name="n${n.nivel}_locuri" min="1" max="6" value="${n.locuri}"></td>
                  <td><input class="ct-in" style="width:200px" type="text" name="n${n.nivel}_eticheta" value="${esc(n.eticheta || "")}" placeholder="ex. paleți înalți"></td>
                  <td>${n.locuri * nr(r.campuri)}</td>
                  <td>${ocupatePeNivel.get(n.nivel) || 0}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="form-actions"><button class="btn" type="submit">Salvează nivelurile</button></div>
      </form>

      <h2 style="margin-top:26px">Porțiuni de rând: alt număr de niveluri, alt număr de paleți</h2>
      <p style="font-size:13px;color:var(--text-muted);max-width:880px;margin:0 0 10px">
        Rândul nu e obligatoriu la fel pe toată lungimea lui: poate avea 3 niveluri pe o bucată, 5 pe alta și 1 lângă
        ușă, iar deschiderea câmpului poate ține 3 paleți într-un loc și 2 sau 1 în altul.
        Scrie de la ce câmp până la ce câmp, apoi ce e altfel acolo.
        <strong>O căsuță lăsată goală înseamnă „ca rândul"</strong> — ${nr(r.niveluri)} niveluri și ${nr(r.locuri_pe_camp)} paleți pe câmp,
        cifrele de sus. Poți schimba doar înălțimea, doar lățimea, sau pe amândouă.
        Ca să ștergi o porțiune, golește-i tot rândul și salvează.
      </p>
      <p style="font-size:13px;max-width:880px;margin:0 0 10px">
        Cum arată rândul acum: ${plan.uniform ? `toate cele ${nr(r.campuri)} câmpuri cu ${nr(r.niveluri)} niveluri × ${nr(r.locuri_pe_camp)} paleți` : `câmpurile ${rezumatSectoare(plan, nr(r.campuri))}`}
        — <strong>${plan.locuri} locuri</strong> în total.
      </p>
      <form class="form" method="post" action="/stocuri/ct-park/configurare/${r.id}/sectoare" style="max-width:640px">
        <table class="table" style="margin-bottom:10px">
          <thead><tr><th>De la câmpul</th><th>Până la câmpul</th><th>Câte niveluri</th><th>Câți paleți / câmp</th></tr></thead>
          <tbody>${formSectoare}</tbody>
        </table>
        <div class="form-actions"><button class="btn" type="submit">Salvează porțiunile</button></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted);max-width:880px;margin:8px 0 0">
        Aceleași lucruri se pot face și cu degetul, direct pe desen:
        <a href="/stocuri/ct-park/rand/${r.id}">deschide fața rândului</a> și apasă „Editez raftul".
      </p>

      <style>
        .ct-in { width:110px; padding:4px 6px; font-size:13px; }
        .ct-niv-butoane { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
      </style>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Rândul ${r.numar}`, active: "/stocuri/ct-park", body }));
  });

  router.post("/stocuri/ct-park/configurare/:id", async (ctx) => {
    const b = ctx.body;
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/stocuri/ct-park/configurare");
    const campuri = Math.max(1, Math.round(nr(b.campuri) || r.campuri));
    const niveluri = Math.max(1, Math.round(nr(b.niveluri) || r.niveluri));
    const perCamp = Math.max(1, Math.round(nr(b.locuri_pe_camp) || r.locuri_pe_camp));

    // Nu tăiem raftul de sub marfă. Dacă noile cifre ar lăsa pe dinafară un
    // loc pe care stă o paletă, refuzăm și spunem care.
    //
    // Verificarea era un singur SQL cu `l.nivel > ?`, și a devenit greșită
    // când rândul a putut avea porțiuni de înălțimi diferite: cifra de aici
    // e doar implicitul câmpurilor fără porțiune proprie, iar un câmp dintr-un
    // sector de 5 niveluri nu trebuie tăiat fiindcă rândul a coborât la 3.
    const sect = await sectoareRand(r.id);
    const viitor = nivelurilePeCamp({ ...r, niveluri }, sect, campuri);
    const afara = await locuriInAfara(
      r.id,
      campuri,
      (c) => viitor.get(c) || 0,
      locuriLaViitor(r, sect, campuri, () => perCamp)
    );
    if (afara.length) {
      const mesaj = `Nu pot micșora rândul: pe locurile ${afara.slice(0, 10).map((a) => a.adresa).join(", ")} stă marfă. Scoate-o întâi din depozit.`;
      return redirect(ctx.res, `/stocuri/ct-park/configurare/${r.id}?eroare=${encodeURIComponent(mesaj)}`);
    }

    await db
      .prepare(
        `UPDATE ct_randuri SET numar = ?, eticheta = ?, campuri = ?, niveluri = ?, locuri_pe_camp = ?,
                latime_loc = ?, adancime_loc = ?, inaltime_nivel = ?, activ = ? WHERE id = ?`
      )
      .run(
        Math.max(1, Math.round(nr(b.numar) || r.numar)),
        CATEGORII.includes(String(b.eticheta || "")) ? String(b.eticheta) : null,
        campuri,
        niveluri,
        perCamp,
        Math.round(nr(b.latime_loc) || r.latime_loc),
        Math.round(nr(b.adancime_loc) || r.adancime_loc),
        Math.round(nr(b.inaltime_nivel) || r.inaltime_nivel),
        String(b.activ) === "0" ? 0 : 1,
        r.id
      );
    await regenereazaLocuri(r.id);
    redirect(ctx.res, "/stocuri/ct-park/configurare");
  });
}

// Locurile unui rând, refăcute din cifrele lui. Se adaugă ce lipsește și se
// șterge ce a rămas pe dinafară — dar niciodată un loc pe care stă marfă
// (ruta de salvare oprește asta înainte să ajungă aici).
async function regenereazaLocuri(randId) {
  const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(randId);
  if (!r) return;
  const { niveluri, peCamp, locuriLa } = await planRand(r);

  // Tot ce TREBUIE să existe după configurația de acum. Și înălțimea, și
  // lățimea se iau de pe CÂMP, nu de pe rând: pe câmpurile dintr-un sector
  // de 2 niveluri nu se generează locuri la nivelul 3, iar într-un câmp de
  // 2 paleți nu se generează poziția 3 — oricât de înalt sau de larg ar fi
  // restul rândului. Un loc generat degeaba nu e inofensiv: e o adresă pe
  // care sistemul o propune, iar omul se duce cu paleta la un raft care nu
  // există acolo.
  const cerute = new Set();
  for (const n of niveluri) {
    for (let camp = 1; camp <= nr(r.campuri); camp++) {
      if (n.nivel > (peCamp.get(camp) || 0)) continue;
      for (let poz = 1; poz <= locuriLa(camp, n.nivel); poz++) cerute.add(`${n.nivel}|${camp}|${poz}`);
    }
  }

  const existente = await db.prepare("SELECT id, nivel, camp, pozitie FROM ct_locuri WHERE rand_id = ?").all(randId);
  const h = new Set(existente.map((l) => `${l.nivel}|${l.camp}|${l.pozitie}`));
  for (const k of cerute) {
    if (h.has(k)) continue;
    const [nivel, camp, poz] = k.split("|").map(Number);
    await db
      .prepare("INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa) VALUES (?, ?, ?, ?, ?)")
      .run(randId, nivel, camp, poz, adresaLoc(r.numar, camp, nivel, poz));
  }

  // Ce a rămas pe dinafară se șterge — dar niciodată un loc pe care stă
  // marfă. Rutele de salvare opresc asta înainte să ajungă aici, verificarea
  // de aici e plasa de siguranță.
  const ocupate = new Set((await db.prepare("SELECT loc_id FROM ct_ocupari").all()).map((o) => Number(o.loc_id)));
  for (const l of existente) {
    if (cerute.has(`${l.nivel}|${l.camp}|${l.pozitie}`)) continue;
    if (ocupate.has(Number(l.id))) continue;
    await db.prepare("DELETE FROM ct_locuri WHERE id = ?").run(l.id);
  }

  // Numărul rândului se poate schimba, deci adresele se rescriu mereu.
  const toate = await db.prepare("SELECT id, nivel, camp, pozitie FROM ct_locuri WHERE rand_id = ?").all(randId);
  for (const l of toate) {
    const a = adresaLoc(r.numar, l.camp, l.nivel, l.pozitie);
    await db.prepare("UPDATE ct_locuri SET adresa = ? WHERE id = ? AND adresa <> ?").run(a, l.id, a);
  }
}

module.exports = {
  register,
  pozitii,
  ADANCIME,
  SPATE,
  CULOAR,
  adresaLoc,
  // Exportate pentru teste: forma rândului se poate verifica fără să treci
  // prin pagină, iar `bucatiRand` și `nivelurilePeCamp` sunt pur aritmetice.
  nivelurilePeCamp,
  paletiPeCamp,
  bucatiRand,
  sectoareRand,
  planRand,
  NIVEL_MAX,
  PALETI_MAX,
};
