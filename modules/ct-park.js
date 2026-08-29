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

const ADANCIME = 1100; // adâncimea unui rând de raft, văzută în secțiune
const SPATE = 200; // jocul dintre două rânduri așezate spate în spate
const CULOAR = 3200; // culoarul de lucru dintre grupuri
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
const GRUPURI = [[8], [7, 6], [5, 4], [3, 2], [1]];

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
    ["/stocuri/ct-park/paleti", "Paleți în depozit"],
    ["/stocuri/ct-park/configurare", "Configurare rânduri"],
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
  router.get("/stocuri/ct-park/sectiune", paginaSectiune);

  // ---- Harta: rândurile, cu gradul de umplere ----------------------------
  router.get("/stocuri/ct-park", async (ctx) => {
    const randuri = await sumarRanduri();
    const totalLocuri = randuri.reduce((s, r) => s + r.locuri, 0);
    const totalOcupate = randuri.reduce((s, r) => s + r.ocupate, 0);
    const paleti = nr((await db.prepare("SELECT COUNT(*) AS n FROM ct_paleti WHERE data_iesire IS NULL").get()).n);

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
        <div class="card"><div class="label">Rânduri</div><div class="value">${randuri.length}</div></div>
        <div class="card"><div class="label">Locuri de palet</div><div class="value">${totalLocuri}</div></div>
        <div class="card"><div class="label">Ocupate</div><div class="value">${totalOcupate}</div>
          <div style="font-size:12px;color:var(--text-muted)">${totalLocuri ? Math.round((totalOcupate / totalLocuri) * 100) : 0}% din depozit</div></div>
        <div class="card"><div class="label">Paleți în depozit</div><div class="value">${paleti}</div>
          <div style="font-size:12px;color:var(--text-muted)">unii ocupă 2–3 locuri</div></div>
      </div>

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
              <div style="font-size:11px;color:var(--text-muted)">${r.campuri} câmpuri × ${r.niveluri} niveluri × ${r.locuri_pe_camp} paleți</div>
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

  // ---- Fața unui rând ----------------------------------------------------
  router.get("/stocuri/ct-park/rand/:id", async (ctx) => {
    const r = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(ctx.params.id);
    if (!r) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/stocuri/ct-park", body: "<p>Rândul nu există.</p>" }));
    const locuri = await locuriRand(r.id);

    // Cheia „nivel|camp|pozitie" ca să pot desena grila fără să caut în listă.
    const h = new Map();
    for (const l of locuri) h.set(`${l.nivel}|${l.camp}|${l.pozitie}`, l);

    const paletiRand = new Map();
    for (const l of locuri) if (l.palet_id) paletiRand.set(Number(l.palet_id), l);

    const ocupate = locuri.filter((l) => l.palet_id).length;
    const latimeCamp = nr(r.latime_loc) * nr(r.locuri_pe_camp);

    let grila = "";
    for (let nivel = nr(r.niveluri); nivel >= 1; nivel--) {
      let celule = "";
      for (let camp = 1; camp <= nr(r.campuri); camp++) {
        let pozitii = "";
        for (let poz = 1; poz <= nr(r.locuri_pe_camp); poz++) {
          const l = h.get(`${nivel}|${camp}|${poz}`);
          if (!l) {
            pozitii += `<div class="ct-loc lipsa"></div>`;
            continue;
          }
          const ocupat = !!l.palet_id;
          const culoare = ocupat ? CULORI_CATEGORII[l.palet_categorie || l.categorie] || "#5a6472" : null;
          const titlu = ocupat
            ? `${l.adresa} · ${l.produs || l.produs_text || "marfă"} · ${nr(l.cantitate) || "?"} ${l.um || ""} · intrat ${l.data_intrare}`
            : `${l.adresa} · liber${l.categorie ? " · zonă " + l.categorie : ""}`;
          pozitii += `<${ocupat ? `a href="/stocuri/ct-park/palet/${l.palet_id}"` : "div"} class="ct-loc${ocupat ? " ocupat" : " liber"}${l.blocat ? " blocat" : ""}"
              title="${esc(titlu)}" data-adresa="${esc(l.adresa)}"
              ${ocupat ? `style="background:${culoare}1f;border-color:${culoare}66"` : ""}>
              <span class="ct-loc-adresa">${esc(String(l.pozitie))}</span>
              ${ocupat ? `<span class="ct-loc-marfa">${esc(String(l.produs || l.produs_text || "").slice(0, 22))}</span>` : ""}
            </${ocupat ? "a" : "div"}>`;
        }
        const zona = h.get(`${nivel}|${camp}|1`);
        celule += `<div class="ct-camp" data-nivel="${nivel}" data-camp="${camp}">
            <div class="ct-camp-locuri">${pozitii}</div>
            <div class="ct-camp-eticheta">${camp}${zona && zona.categorie ? ` · ${esc(zona.categorie)}` : ""}</div>
          </div>`;
      }
      grila += `<div class="ct-nivel"><div class="ct-nivel-eticheta">N${nivel}</div><div class="ct-nivel-campuri">${celule}</div></div>`;
    }

    const body = `
      ${subtabs("/stocuri/ct-park")}
      <div class="toolbar">
        <a class="btn secondary" href="/stocuri/ct-park">← Harta depozitului</a>
        <a class="btn" href="/stocuri/ct-park/intrare?rand=${r.id}">+ Intrare marfă în rândul ăsta</a>
      </div>
      <h1 style="margin:6px 0 2px">Rândul ${r.numar} ${pastila(r.eticheta)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px">
        ${r.campuri} câmpuri × ${r.niveluri} niveluri × ${r.locuri_pe_camp} paleți = ${locuri.length} locuri, din care
        <strong>${ocupate} ocupate</strong>. Un loc de palet: ${nr(r.latime_loc)} × ${nr(r.adancime_loc)} mm,
        înălțime utilă ${nr(r.inaltime_nivel)} mm. Un câmp are ${(latimeCamp / 1000).toFixed(2)} m deschidere.
      </p>

      <div class="ct-fata">
        <div class="ct-grila">${grila}</div>
        <div class="ct-podea">pardoseală</div>
      </div>

      <p class="ct-legenda2">
        ${CATEGORII.map((c) => `<span><i style="background:${CULORI_CATEGORII[c]}"></i>${esc(c)}</span>`).join("")}
        <span><i style="background:#eceff3;border:1px solid var(--border)"></i>liber</span>
        <span style="color:var(--text-muted)">Click pe un loc ocupat ca să vezi ce e pe el.</span>
      </p>

      <h2>Zone pe categorii</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-top:-6px;max-width:760px">
        Categoria se pune pe zona de trei paleți dintr-un câmp, nu pe locul singur — aia e unitatea pe care o
        rezervi unei categorii de marfă. Lasă gol ca să eliberezi zona.
      </p>
      <form class="form" method="post" action="/stocuri/ct-park/rand/${r.id}/zone" style="max-width:900px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
          ${Array.from({ length: nr(r.niveluri) }, (_, i) => nr(r.niveluri) - i)
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
        .ct-nivel-eticheta { width:34px; flex:none; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:12px; color:var(--text-muted); border-right:2px solid var(--border); }
        .ct-nivel-campuri { display:flex; gap:8px; flex:1; }
        .ct-camp { flex:1; min-width:96px; }
        .ct-camp-locuri { display:flex; gap:2px; }
        .ct-camp-eticheta { font-size:10px; color:var(--text-muted); text-align:center; margin-top:2px; }
        .ct-loc { flex:1; min-width:26px; height:42px; border:1px solid var(--border); border-radius:3px; background:#f7f8fa;
                  display:flex; flex-direction:column; align-items:center; justify-content:center; text-decoration:none; color:inherit; overflow:hidden; }
        .ct-loc.ocupat { cursor:pointer; }
        .ct-loc.ocupat:hover { outline:2px solid var(--primary); }
        .ct-loc.lipsa { background:repeating-linear-gradient(45deg,#f0f0f0,#f0f0f0 4px,#fff 4px,#fff 8px); border-style:dashed; }
        .ct-loc.blocat { background:#f0e2e2; }
        .ct-loc-adresa { font-size:10px; color:var(--text-muted); }
        .ct-loc-marfa { font-size:9px; line-height:1.05; text-align:center; padding:0 2px; }
        .ct-podea { margin-top:6px; margin-left:42px; border-top:3px solid #8a8f98; font-size:11px; color:var(--text-muted); padding-top:2px; }
        .ct-legenda2 { display:flex; gap:16px; flex-wrap:wrap; align-items:center; font-size:12px; margin:10px 0 18px; }
        .ct-legenda2 i { display:inline-block; width:12px; height:12px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
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
        </div>
        <p style="margin-top:12px"><strong>Adresa:</strong>
          ${locuri.map((l) => `<a href="/stocuri/ct-park/rand/${l.rand_id}" class="badge gri" style="text-decoration:none">${esc(l.adresa)}</a>`).join(" ")}
          ${locuri.length > 1 ? `<span style="color:var(--text-muted);font-size:12px"> — marfă lată, ține ${locuri.length} locuri</span>` : ""}
        </p>
        ${p.observatii ? `<p style="white-space:pre-wrap"><strong>Observații:</strong> ${esc(p.observatii)}</p>` : ""}
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

    const paleti = await db
      .prepare(
        `SELECT p.id, p.cod, p.cantitate, p.um, p.lot, p.categorie, p.data_intrare,
                COALESCE(pr.denumire, p.produs_text) AS marfa
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.data_iesire IS NULL${undeCauta}
          ORDER BY p.id DESC LIMIT 200`
      )
      .all(...argCauta);

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
                ['<input type="checkbox" id="bifa-toti">', "Paletă", "Marfă", "Cantitate", "Lot", "Adresă", "Intrată la"],
                paleti.map((p) => {
                  const adr = ha.get(Number(p.id)) || [];
                  return [
                    `<input type="checkbox" class="bifa-palet" name="paleti" value="${p.id}"${preselectat === Number(p.id) ? " checked" : ""}>`,
                    `<a href="/stocuri/ct-park/palet/${p.id}">${esc(p.cod)}</a>`,
                    esc(p.marfa || "—"),
                    nr(p.cantitate) ? `${nr(p.cantitate).toLocaleString("ro-RO")} ${esc(p.um || "")}` : "—",
                    esc(p.lot || "—"),
                    adr.length ? `<code>${adr.map((a) => esc(a)).join(" + ")}</code>` : "—",
                    esc(String(p.data_intrare || "").slice(0, 10)),
                  ];
                })
              )
            : `<p style="color:var(--text-muted)">${cauta ? "Niciun palet care să semene cu „" + esc(cauta) + "”." : "Nu e nimic în depozit."}</p>`
        }

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
        });
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
    const scoase = [];
    for (const id of ids) {
      const p = await db.prepare("SELECT id FROM ct_paleti WHERE id = ? AND data_iesire IS NULL").get(id);
      if (!p) continue; // deja ieșit între timp — nu-l scoatem de două ori
      await db.prepare("UPDATE ct_paleti SET data_iesire = ? WHERE id = ?").run(azi, id);
      await db.prepare("DELETE FROM ct_ocupari WHERE palet_id = ?").run(id);
      await db
        .prepare(
          `INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, client, comanda_numar, comanda_data, adresa, data, observatii, creat_de)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          cine
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

    const body = `
      ${subtabs("/stocuri/ct-park/paleti")}
      <div class="toolbar"><a class="btn" href="/stocuri/ct-park/intrare">+ Intrare marfă</a></div>
      ${table(
        ["Cod", "Marfă", "Cantitate", "Lot", "Categorie", "Adresă", "Intrată", "Stare", ""],
        paleti.map((p) => [
          `<a href="/stocuri/ct-park/palet/${p.id}">${esc(p.cod)}</a>`,
          p.produs_id ? `<a href="/produse/${p.produs_id}">${esc(p.produs || "—")}</a>` : esc(p.produs_text || "—"),
          nr(p.cantitate) ? nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "") : "—",
          esc(p.lot || "—"),
          pastila(p.categorie) || "—",
          (ha.get(Number(p.id)) || []).map((a) => esc(a)).join(" ") || '<span class="badge gri">fără loc</span>',
          esc(p.data_intrare),
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
    const cauta = String(ctx.query.q || "").trim();
    let gasite = [];
    if (cauta) {
      gasite = await db
        .prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE denumire ILIKE ? OR cod ILIKE ? ORDER BY denumire LIMIT 40")
        .all(`%${cauta}%`, `%${cauta}%`);
    }

    if (!randuri.length) return redirect(ctx.res, "/stocuri/ct-park");

    const body = `
      ${subtabs("/stocuri/ct-park/intrare")}
      <h1 style="margin:6px 0 2px">Intrare marfă în CT-Park</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px">
        Pasul 1: ce intră și pe câți paleți. Pasul 2: ERP-ul propune locurile libere, tu le confirmi și primești
        etichetele de 100 × 150 mm cu adresa generată.
      </p>

      <form class="filtre" method="get" action="/stocuri/ct-park/intrare">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută produsul în catalog…" style="min-width:280px">
        ${ctx.query.rand ? `<input type="hidden" name="rand" value="${esc(String(ctx.query.rand))}">` : ""}
        <button class="btn small" type="submit">Caută</button>
      </form>

      <form class="form" method="post" action="/stocuri/ct-park/intrare" style="max-width:900px">
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
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
          <label class="field">…sau denumirea scrisă liber<input name="produs_text" placeholder="folie stretch 23µ reciclat"></label>
          <label class="field">Cantitate totală<input type="number" name="cantitate" min="0" step="0.01"></label>
          <label class="field">UM<input name="um" placeholder="kg"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Lot<input name="lot"></label>
          <label class="field">Categorie
            <select name="categorie">
              <option value="">—</option>
              ${CATEGORII.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            </select>
          </label>
          <label class="field">Câți paleți<input type="number" name="paleti" min="1" max="60" value="1" required></label>
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
    grupuri.sort((a, b2) => scor(a) - scor(b2));
    const alese = grupuri.slice(0, catePaleti);

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
        alese.length < catePaleti
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
          `INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, um, lot, categorie, data_intrare, observatii, creat_de)
           VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
          ctx.user ? ctx.user.nume : null
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
      <h1 style="margin:6px 0 2px">Configurare rânduri</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:820px">
        Câte câmpuri și câte niveluri are fiecare rând. Din cifrele astea se nasc adresele de palet — de-aia,
        dacă schimbi numărul de câmpuri sau de niveluri, locurile se regenerează. Locurile pe care stă marfă
        <strong>nu se șterg</strong>: dacă ai reduce rândul sub ele, salvarea se oprește și îți spune care.
      </p>

      ${
        randuri.length
          ? table(
              ["Rând", "Etichetă", "Câmpuri", "Niveluri", "Paleți / câmp", "Locuri", "Ocupate", ""],
              randuri.map((r) => [
                `<a href="/stocuri/ct-park/rand/${r.id}"><strong>${r.numar}</strong></a>`,
                pastila(r.eticheta) || "—",
                String(r.campuri),
                String(r.niveluri),
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
    const eroare = String(ctx.query.eroare || "");

    const body = `
      ${subtabs("/stocuri/ct-park/configurare")}
      <div class="toolbar"><a class="btn secondary" href="/stocuri/ct-park/configurare">← Toate rândurile</a>
        <a class="btn secondary" href="/stocuri/ct-park/rand/${r.id}">Vezi fața rândului</a></div>
      ${eroare ? `<div class="detail-box" style="border-left:4px solid var(--danger)">${esc(eroare)}</div>` : ""}
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
      <p style="font-size:12px;color:var(--text-muted);max-width:760px">
        ${ocupate.length ? `Pe rândul ăsta stau ${ocupate.length} paleți: ${ocupate.slice(0, 12).map((o) => esc(o.adresa)).join(", ")}${ocupate.length > 12 ? "…" : ""}. Nu poți micșora rândul sub ei.` : "Rândul e gol, îl poți redimensiona liber."}
      </p>
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
    const afara = await db
      .prepare(
        `SELECT l.adresa FROM ct_locuri l
           JOIN ct_ocupari o ON o.loc_id = l.id JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
          WHERE l.rand_id = ? AND (l.camp > ? OR l.nivel > ? OR l.pozitie > ?)
          ORDER BY l.nivel DESC, l.camp LIMIT 10`
      )
      .all(r.id, campuri, niveluri, perCamp);
    if (afara.length) {
      const mesaj = `Nu pot micșora rândul: pe locurile ${afara.map((a) => a.adresa).join(", ")} stă marfă. Scoate-o întâi din depozit.`;
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
  const existente = await db.prepare("SELECT id, nivel, camp, pozitie FROM ct_locuri WHERE rand_id = ?").all(randId);
  const h = new Set(existente.map((l) => `${l.nivel}|${l.camp}|${l.pozitie}`));
  for (let nivel = 1; nivel <= nr(r.niveluri); nivel++) {
    for (let camp = 1; camp <= nr(r.campuri); camp++) {
      for (let poz = 1; poz <= nr(r.locuri_pe_camp); poz++) {
        if (h.has(`${nivel}|${camp}|${poz}`)) continue;
        await db
          .prepare("INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa) VALUES (?, ?, ?, ?, ?)")
          .run(randId, nivel, camp, poz, adresaLoc(r.numar, camp, nivel, poz));
      }
    }
  }
  await db
    .prepare(
      `DELETE FROM ct_locuri WHERE rand_id = ? AND (camp > ? OR nivel > ? OR pozitie > ?)
        AND id NOT IN (SELECT loc_id FROM ct_ocupari)`
    )
    .run(randId, nr(r.campuri), nr(r.niveluri), nr(r.locuri_pe_camp));
  // Numărul rândului se poate schimba, deci adresele se rescriu mereu.
  const toate = await db.prepare("SELECT id, nivel, camp, pozitie FROM ct_locuri WHERE rand_id = ?").all(randId);
  for (const l of toate) {
    const a = adresaLoc(r.numar, l.camp, l.nivel, l.pozitie);
    await db.prepare("UPDATE ct_locuri SET adresa = ? WHERE id = ? AND adresa <> ?").run(a, l.id, a);
  }
}

module.exports = { register, pozitii, ADANCIME, SPATE, CULOAR, adresaLoc };
