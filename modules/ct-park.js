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
const { esc, layout } = require("../lib/render");
const { send } = require("../lib/router");

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

function register(router) {
  router.get("/stocuri/ct-park", async (ctx) => {
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
              Rândurile din desen nu sunt încă legate de locațiile astea — spune-mi care rând ține care gestiune și
              le leg, ca la click pe un rând să vezi direct ce e în el.
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
    send(ctx.res, 200, layout({ user: ctx.user, title: "Depozit CT-Park", active: "/stocuri/ct-park", body }));
  });
}

module.exports = { register, pozitii, ADANCIME, SPATE, CULOAR };
