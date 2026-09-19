"use strict";
// Calculatorul de cutii din carton — costul complet al unei cutii, pe cele
// două fluxuri posibile de producție.
//
// De ce există: prețul unei cutii se năștea într-un Excel cu două foi care
// calculau același lucru pe două linii diferite. Aici e același model, cu
// aceleași formule, dar cifrele stau o singură dată în baza de date — deci
// toți dau același preț, iar când se mișcă cursul sau prețul cartonului se
// schimbă într-un singur loc.
//
// Cele două fluxuri:
//   FORMATE + LIPITE — două mașini (debitare+print și formare+lipire), 50
//     cutii/min fiecare, 3 operatori pe amândouă.
//   AUTOFORMARE      — o singură mașină, cu ștanța montată pe debitare, 150
//     cutii/min, 2 operatori; fără lipire, dar cu ștanța de amortizat.
//
// Lanțul de cost, tot în €/cutie și convertit la final în lei:
//   PLACĂ      — aria plăcii × prețul cartonului (€/1000 m²)
//   TRANSPORT  — costul camionului împărțit la plăcile care încap în el
//   CERNEALĂ   — aria tipărită × consum per culoare × nr. culori
//   MANOPERĂ   — operatori × cost/oră ÷ capacitatea orară a liniei
//   ENERGIE    — kWh/oră × preț ÷ capacitatea orară
//   SETUP      — reglarea mașinii, amortizată pe lot
//   ȘTANȚĂ     — doar la autoformare: prețul ștanței ÷ durata ei de viață
//
// Adezivul (cleiul) NU e inclus — a fost scos explicit din fișierul primit —
// și nici amortizarea utilajelor; din ele apare doar energia consumată.
//
// Convenția de culori e cea din fișier:
//   GALBEN = dată confirmată, se scrie de mână
//   BEJ    = presupunere neconfirmată, tot se scrie de mână, dar e de corectat
//   GRI    = calculată automat, nu se atinge

const db = require("../lib/db");
const { esc, layout, table, subnavCrm, selectorCalculator } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Datele de intrare. Al cincilea element: "ok" = confirmat (galben),
// "dc" = de confirmat (bej). Ordinea de aici e ordinea de pe pagină.
const ASUMPTII = [
  ["sect", "1. Curs valutar"],
  ["curs", "Curs de schimb", 5.25, "RON / EUR", "ok"],

  ["sect", "2. Placa de carton — preț și transport"],
  ["placa_lung", "Lungime placă (valoare implicită)", 2007, "mm", "ok"],
  ["placa_lat", "Lățime placă (valoare implicită)", 996, "mm", "ok"],
  ["placi_cutie", "Plăci per cutie", 1, "plăci", "dc"],
  ["pret_carton", "Preț carton", 486, "€ / 1000 m²", "ok"],
  ["transport_eur", "Cost transport (camion / livrare)", 400, "€/transport", "dc"],
  ["placi_transport", "Nr. plăci per transport", 2000, "plăci", "dc"],

  ["sect", "3. Print — cerneală"],
  ["print_lung", "Lungime zonă tipărită (implicit)", 300, "mm", "ok"],
  ["print_inalt", "Înălțime zonă tipărită (implicit)", 56, "mm", "ok"],
  ["print_fete", "Nr. fețe printate (implicit)", 2, "fețe", "ok"],
  ["print_culori", "Nr. culori (implicit)", 1, "culori (1–4)", "ok"],
  ["cerneala_g_m2", "Consum cerneală, per culoare", 3, "g/m² / culoare", "dc"],
  ["cerneala_eur", "Preț cerneală", 10, "€/litru", "ok"],
  ["cerneala_dens", "Densitate cerneală", 1, "g/ml", "dc"],

  ["sect", "4. Linia „formate + lipite” — două mașini"],
  ["l1_viteza", "Viteză linii (fiecare)", 50, "cutii/minut", "ok"],
  ["l1_operatori", "Număr operatori (total, pe ambele linii)", 3, "persoane", "ok"],
  ["l1_energie_debit", "Energie — mașina debitare + print", 75, "kWh/oră", "ok"],
  ["l1_energie_formare", "Energie — mașina formare + lipire", 15, "kWh/oră", "ok"],

  ["sect", "5. Linia „autoformare” — o mașină, cu ștanță"],
  ["l2_viteza", "Viteză mașină (debitare + ștanțare)", 150, "cutii/minut", "ok"],
  ["l2_operatori", "Număr operatori", 2, "persoane", "ok"],
  ["l2_energie", "Energie — mașina debitare + ștanțare", 75, "kWh/oră", "ok"],
  ["stanta_eur", "Cost achiziție ștanță", 5000, "€", "dc"],
  ["stanta_viata", "Durată de viață ștanță", 500000, "cutii", "dc"],

  ["sect", "6. Manoperă, energie, setup"],
  ["cost_ora", "Cost orar per operator", 50, "lei/oră", "ok"],
  ["pret_energie", "Preț energie electrică", 1, "lei/kWh", "ok"],
  ["setup_min", "Timp setup / reglare per tip de cutie", 30, "minute", "ok"],
  ["lot", "Dimensiune lot implicită", 5000, "cutii per comandă", "dc"],
];

const CAMPURI = ASUMPTII.filter((x) => x[0] !== "sect");
const IMPLICITE = Object.fromEntries(CAMPURI.map((c) => [c[0], c[2]]));

// Valorile calculate care apar sub câmpurile secțiunii lor, ca în foile din
// Excel. Cheia e titlul secțiunii.
const CALCULATE = {
  "2. Placa de carton — preț și transport": [
    ["Preț carton", (r) => r.pretCartonM2, "€/m²"],
    ["Cost transport per placă", (r) => r.transportPlaca, "€/placă"],
  ],
  "3. Print — cerneală": [
    ["Preț cerneală", (r) => r.cernealaEurG, "€/g"],
  ],
  "4. Linia „formate + lipite” — două mașini": [
    ["Capacitate linie", (r) => r.L1.capacitate, "cutii/oră"],
    ["Manoperă + energie", (r) => r.L1.totalRon, "lei/oră"],
    ["Cost procesare", (r) => r.L1.per1000, "€/1000 buc"],
  ],
  "5. Linia „autoformare” — o mașină, cu ștanță": [
    ["Capacitate mașină", (r) => r.L2.capacitate, "cutii/oră"],
    ["Manoperă + energie", (r) => r.L2.totalRon, "lei/oră"],
    ["Cost procesare", (r) => r.L2.per1000, "€/1000 buc"],
    ["Ștanță, amortizată", (r) => r.stanta1000, "€/1000 buc"],
  ],
};

const LINII = [
  ["lipire", "Formate + lipite"],
  ["autoformare", "Autoformare (ștanță)"],
];

// Tipurile de cutie salvate. Cele două implicite reproduc exact cele două foi
// din fișierul primit — aceeași cutie, calculată pe ambele fluxuri.
const TIPURI_IMPLICITE = [
  {
    nume: "820×160×820 — formate + lipite", linie: "lipire",
    placa_lung: 2007, placa_lat: 996, placi: 1,
    print_lung: 300, print_inalt: 56, fete: 2, culori: 1, lot: 5000,
  },
  {
    nume: "820×160×820 — autoformare", linie: "autoformare",
    placa_lung: 2007, placa_lat: 996, placi: 1,
    print_lung: 300, print_inalt: 56, fete: 2, culori: 1, lot: 5000,
  },
];

// ---- Motorul de calcul ----------------------------------------------------
// Primește asumpțiile și tipurile de cutie; întoarce tot ce se afișează.
// Nu atinge baza de date — ca să poată fi verificat cu creionul pe hârtie.
function calculeaza(a, tipuri) {
  const n = (k) => {
    const v = Number(a[k]);
    return isFinite(v) ? v : 0;
  };
  const curs = n("curs");

  // Prețul cartonului vine în €/1000 m², deci se împarte la 1000.
  const pretCartonM2 = n("pret_carton") / 1000;
  // Transportul: un camion împărțit la câte plăci încap în el.
  const transportPlaca = n("placi_transport") ? n("transport_eur") / n("placi_transport") : 0;
  // Cerneala vine în €/litru; densitatea o face €/gram.
  const cernealaEurG = n("cerneala_dens") ? n("cerneala_eur") / 1000 / n("cerneala_dens") : 0;

  // ---- O linie de producție: manoperă + energie, pe oră și pe cutie -------
  const linie = (eticheta, viteza, operatori, kwh) => {
    const capacitate = viteza * 60;
    const manopRon = operatori * n("cost_ora");
    const energieRon = kwh * n("pret_energie");
    const totalRon = manopRon + energieRon;
    const totalEur = curs ? totalRon / curs : 0;
    const perCutie = capacitate ? totalEur / capacitate : 0;
    const manop1000 = capacitate && curs ? (manopRon / curs / capacitate) * 1000 : 0;
    const energie1000 = capacitate && curs ? (energieRon / curs / capacitate) * 1000 : 0;
    // Setup-ul se plătește la același cost orar ca producția: aceiași oameni,
    // aceleași mașini pornite. E ipoteza din fișier.
    const setupRon = totalRon * (n("setup_min") / 60);
    return {
      eticheta, viteza, operatori, kwh, capacitate,
      manopRon, energieRon, totalRon, totalEur,
      perCutie, per1000: perCutie * 1000, manop1000, energie1000,
      setupRon, setupEur: curs ? setupRon / curs : 0,
    };
  };

  const L1 = linie("Formate + lipite", n("l1_viteza"), n("l1_operatori"),
    n("l1_energie_debit") + n("l1_energie_formare"));
  const L2 = linie("Autoformare (ștanță)", n("l2_viteza"), n("l2_operatori"), n("l2_energie"));
  const LINIE = { lipire: L1, autoformare: L2 };

  // Ștanța e o investiție, nu un consum: se împarte la câte cutii scoate.
  const stantaBuc = n("stanta_viata") ? n("stanta_eur") / n("stanta_viata") : 0;
  const stanta1000 = stantaBuc * 1000;

  // ---- Un tip de cutie: de la placă la preț ------------------------------
  const unTip = (f) => {
    const lung = Number(f.placa_lung) || 0;
    const lat = Number(f.placa_lat) || 0;
    const placi = Number(f.placi) || 0;
    const pl = Number(f.print_lung) || 0;
    const pi = Number(f.print_inalt) || 0;
    const fete = Number(f.fete) || 0;
    const culori = Number(f.culori) || 0;
    const lot = Number(f.lot) || 0;
    const cheieLinie = String(f.linie || "lipire").toLowerCase() === "autoformare" ? "autoformare" : "lipire";
    const L = LINIE[cheieLinie];
    const auto = cheieLinie === "autoformare";

    // Aria plăcii de la furnizor — asta intră în cost, nu desfășurata
    // calculată din geometria cutiei (fișierul o ține doar ca verificare).
    const ariePlaca = (lung / 1000) * (lat / 1000);
    const arieTotal = ariePlaca * placi;
    const cMaterial = arieTotal * pretCartonM2;
    const cTransport = transportPlaca * placi;

    // Printul: aria tipărită × consumul pe culoare × numărul de culori.
    const ariePrint = (pl / 1000) * (pi / 1000) * fete;
    const gCerneala = ariePrint * n("cerneala_g_m2") * culori;
    const cCerneala = gCerneala * cernealaEurG;

    const cManopera = L.manop1000 / 1000;
    const cEnergie = L.energie1000 / 1000;
    // Reglarea mașinii: o dată per lot, împărțită la cutiile lotului — de-aia
    // costul pe bucată scade cu mărimea comenzii.
    const cSetup = lot && curs ? L.setupRon / curs / lot : 0;
    const cStanta = auto ? stantaBuc : 0;

    const totalBuc = cMaterial + cTransport + cCerneala + cManopera + cEnergie + cSetup + cStanta;
    const total1000 = totalBuc * 1000;

    // Necesarul pentru un lot întreg.
    const placiLot = placi * lot;
    const m2Lot = arieTotal * lot;
    const gCernealaLot = gCerneala * lot;
    const transporturi = n("placi_transport") ? placiLot / n("placi_transport") : 0;
    const oreLot = L.capacitate ? lot / L.capacitate : 0;

    const alerte = [];
    if (!lung || !lat) alerte.push("placa n-are dimensiuni");
    if (!placi) alerte.push("nu e trecut câte plăci intră într-o cutie");
    if (!lot) alerte.push("fără dimensiune de lot — setup-ul nu se poate amortiza");
    if (culori > 4) alerte.push("peste 4 culori, mai mult decât poate mașina");
    if (fete > 2) alerte.push("mai mult de 2 fețe printate");

    return {
      nume: String(f.nume || "").trim(), linie: cheieLinie, auto,
      etichetaLinie: auto ? "Autoformare" : "Formate + lipite",
      placa_lung: lung, placa_lat: lat, placi, print_lung: pl, print_inalt: pi,
      fete, culori, lot,
      ariePlaca, arieTotal, ariePrint, gCerneala,
      cMaterial, cTransport, cCerneala, cManopera, cEnergie, cSetup, cStanta,
      totalBuc, total1000,
      lei: totalBuc * curs, lei1000: total1000 * curs,
      placiLot, m2Lot, gCernealaLot, transporturi, oreLot,
      valoareLot: totalBuc * curs * lot,
      ponderePlaca: totalBuc ? (cMaterial + cTransport) / totalBuc : 0,
      alerte,
    };
  };

  const tipList = (tipuri || []).map(unTip);

  // Comparația celor două fluxuri la aceeași cutie — de-aici se vede că
  // diferența dintre ele e mică, pentru că placa e aproape tot costul.
  const cutieRef = {
    nume: "referință", placa_lung: n("placa_lung"), placa_lat: n("placa_lat"),
    placi: n("placi_cutie"), print_lung: n("print_lung"), print_inalt: n("print_inalt"),
    fete: n("print_fete"), culori: n("print_culori"), lot: n("lot"),
  };
  const refLipire = unTip(Object.assign({}, cutieRef, { linie: "lipire" }));
  const refAuto = unTip(Object.assign({}, cutieRef, { linie: "autoformare" }));

  const total = { lot: 0, placi: 0, m2: 0, cerneala: 0, valoare: 0, ore: 0 };
  for (const x of tipList) {
    total.lot += x.lot;
    total.placi += x.placiLot;
    total.m2 += x.m2Lot;
    total.cerneala += x.gCernealaLot;
    total.valoare += x.valoareLot;
    total.ore += x.oreLot;
  }

  return {
    pretCartonM2, transportPlaca, cernealaEurG,
    L1, L2, LINIE, stantaBuc, stanta1000,
    tipuri: tipList, refLipire, refAuto, total, unTip,
  };
}

// ---- Datele din baza de date ---------------------------------------------
// Două rânduri JSON în setari_app: asumpțiile (se citesc mereu împreună) și
// tipurile de cutie. Un tabel propriu n-ar aduce nimic — nu se caută
// niciodată o singură asumpție.
const CHEIE_A = "cutii_asumptii";
const CHEIE_T = "cutii_tipuri";

async function citesteJson(cheie) {
  const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (!r || !r.valoare) return null;
  try { return JSON.parse(r.valoare); } catch { return null; }
}

async function scrieJson(cheie, obiect) {
  const acum = new Date().toISOString();
  const j = JSON.stringify(obiect);
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(j, acum, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, j, acum);
  return obiect;
}

async function citesteAsumptii() {
  const salvate = (await citesteJson(CHEIE_A)) || {};
  const out = {};
  for (const c of CAMPURI) {
    const v = salvate[c[0]];
    out[c[0]] = v === undefined || v === null || v === "" ? c[2] : Number(v);
    if (!isFinite(out[c[0]])) out[c[0]] = c[2];
  }
  return out;
}

// Se scriu numai cheile cunoscute — deci nimic străin nu poate ajunge în
// asumpții prin formular sau prin adresa paginii. Un câmp care lipsește din
// formular păstrează valoarea salvată (nu devine 0 și nu sare la implicit),
// ca un POST parțial să nu șteargă restul cifrelor.
async function scrieAsumptii(val) {
  const acum = await citesteAsumptii();
  const curat = {};
  for (const c of CAMPURI) {
    const brut = val[c[0]];
    if (brut === undefined || brut === null || String(brut).trim() === "") {
      curat[c[0]] = acum[c[0]];
      continue;
    }
    const v = Number(String(brut).replace(",", "."));
    curat[c[0]] = isFinite(v) ? v : acum[c[0]];
  }
  return scrieJson(CHEIE_A, curat);
}

async function citesteTipuri() {
  const salvate = await citesteJson(CHEIE_T);
  if (!Array.isArray(salvate)) return TIPURI_IMPLICITE.map((x) => Object.assign({}, x));
  return salvate.map((f) => ({
    nume: String(f && f.nume ? f.nume : "").slice(0, 80),
    linie: String(f && f.linie).toLowerCase() === "autoformare" ? "autoformare" : "lipire",
    placa_lung: Number(f && f.placa_lung) || 0,
    placa_lat: Number(f && f.placa_lat) || 0,
    placi: Number(f && f.placi) || 0,
    print_lung: Number(f && f.print_lung) || 0,
    print_inalt: Number(f && f.print_inalt) || 0,
    fete: Number(f && f.fete) || 0,
    culori: Number(f && f.culori) || 0,
    lot: Number(f && f.lot) || 0,
  }));
}

// ---- Formatare -----------------------------------------------------------
const nr = (v, z) => {
  const x = Number(v);
  if (!isFinite(x)) return "—";
  const d = z === undefined ? 2 : z;
  return x.toLocaleString("ro-RO", { minimumFractionDigits: d, maximumFractionDigits: d });
};
// Pentru valorile calculate: până la 4 zecimale, fără zerouri inutile la coadă.
const taieZerouri = (v) => {
  const t = nr(v, 4);
  return t.includes(",") ? t.replace(/0+$/, "").replace(/,$/, "") : t;
};
const numar = (v) => {
  const x = Number(String(v === undefined || v === null ? "" : v).replace(",", "."));
  return isFinite(x) ? x : 0;
};

function register(router) {
  router.get("/calculator/cutii", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const baza = await citesteAsumptii();
    const tipuri = await citesteTipuri();

    // Orice asumpție poate fi suprascrisă din adresa paginii, fără să se
    // salveze — așa se poate trimite un link cu un scenariu („ce iese dacă
    // placa costă 520 €”) fără să se schimbe cifrele pentru toată lumea.
    const a = Object.assign({}, baza);
    const modificat = [];
    for (const c of CAMPURI) {
      const q = ctx.query && ctx.query[c[0]];
      if (q !== undefined && q !== "") {
        const v = numar(q);
        if (isFinite(v) && v !== baza[c[0]]) { a[c[0]] = v; modificat.push(c[1]); }
      }
    }

    const r = calculeaza(a, tipuri);

    // ---- Calcul rapid: o cutie cerută acum, fără să se salveze nimic ------
    const q = ctx.query || {};
    const camp = (cheie, implicit) =>
      q[cheie] === undefined || q[cheie] === "" ? implicit : numar(q[cheie]);
    const cerut = {
      nume: String(q.q_nume || "Cerere nouă").slice(0, 80),
      linie: String(q.q_linie || "lipire").toLowerCase() === "autoformare" ? "autoformare" : "lipire",
      placa_lung: camp("q_lung", a.placa_lung),
      placa_lat: camp("q_lat", a.placa_lat),
      placi: camp("q_placi", a.placi_cutie),
      print_lung: camp("q_plung", a.print_lung),
      print_inalt: camp("q_pinalt", a.print_inalt),
      fete: camp("q_fete", a.print_fete),
      culori: camp("q_culori", a.print_culori),
      lot: camp("q_lot", a.lot),
    };
    const rapid = r.unTip(cerut);
    const celalalt = r.unTip(Object.assign({}, cerut, {
      linie: cerut.linie === "autoformare" ? "lipire" : "autoformare",
    }));
    const marjaRapid = q.q_marja === undefined || q.q_marja === "" ? 25 : numar(q.q_marja);

    const optLinie = (ales) =>
      LINII.map(([v, et]) => `<option value="${v}"${v === ales ? " selected" : ""}>${esc(et)}</option>`).join("");

    const rapidHtml = `
      <form method="get" action="/calculator/cutii" class="form" style="max-width:1100px;margin-bottom:6px">
        <div class="pungi-rapid">
          <label class="field"><span>Client / denumire</span><input type="text" name="q_nume" value="${esc(cerut.nume)}"></label>
          <label class="field"><span>Flux de producție</span><select name="q_linie">${optLinie(cerut.linie)}</select></label>
          <label class="field"><span>Lungime placă <span class="mic">mm</span></span><input type="number" step="any" name="q_lung" value="${esc(String(cerut.placa_lung))}"></label>
          <label class="field"><span>Lățime placă <span class="mic">mm</span></span><input type="number" step="any" name="q_lat" value="${esc(String(cerut.placa_lat))}"></label>
          <label class="field"><span>Plăci / cutie</span><input type="number" step="any" name="q_placi" value="${esc(String(cerut.placi))}"></label>
          <label class="field"><span>Cantitate (lot) <span class="mic">cutii</span></span><input type="number" step="any" name="q_lot" value="${esc(String(cerut.lot))}"></label>
          <label class="field"><span>Zonă print — lungime <span class="mic">mm</span></span><input type="number" step="any" name="q_plung" value="${esc(String(cerut.print_lung))}"></label>
          <label class="field"><span>Zonă print — înălțime <span class="mic">mm</span></span><input type="number" step="any" name="q_pinalt" value="${esc(String(cerut.print_inalt))}"></label>
          <label class="field"><span>Fețe printate</span><input type="number" step="any" name="q_fete" value="${esc(String(cerut.fete))}"></label>
          <label class="field"><span>Culori <span class="mic">1–4</span></span><input type="number" step="any" name="q_culori" value="${esc(String(cerut.culori))}"></label>
          <label class="field"><span>Marjă <span class="mic">% adaos</span></span><input type="number" step="any" name="q_marja" value="${esc(String(marjaRapid))}"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Calculează</button>
          <a class="btn secondary" href="/calculator/cutii">Golește</a></div>
      </form>`;

    const rapidRez = `
      <div class="pungi-rezultat">
        <div class="pungi-mare">
          <span class="mic">Cost / cutie — ${esc(rapid.etichetaLinie)}</span>
          <strong>${nr(rapid.lei, 2)} lei</strong>
          <span class="mic">${nr(rapid.totalBuc, 4)} € &middot; ${nr(rapid.lei1000)} lei / 1000 buc</span>
        </div>
        <div class="pungi-mare">
          <span class="mic">Preț la ${nr(marjaRapid, 0)}% adaos</span>
          <strong style="color:var(--success)">${nr(rapid.lei * (1 + marjaRapid / 100), 2)} lei</strong>
          <span class="mic">${nr(rapid.lei1000 * (1 + marjaRapid / 100))} lei / 1000 buc</span>
        </div>
        <div class="pungi-mare">
          <span class="mic">Valoare lot (cost)</span>
          <strong>${nr(rapid.valoareLot)} lei</strong>
          <span class="mic">${nr(rapid.lot, 0)} cutii &middot; ${nr(rapid.placiLot, 0)} plăci &middot; ${nr(rapid.oreLot, 1)} ore mașină</span>
        </div>
        <div class="pungi-mare">
          <span class="mic">Pe celălalt flux (${esc(celalalt.etichetaLinie)})</span>
          <strong>${nr(celalalt.lei, 2)} lei</strong>
          <span class="mic">${celalalt.lei === rapid.lei ? "la fel" :
            (celalalt.lei < rapid.lei ? "mai ieftin cu " : "mai scump cu ") + nr(Math.abs(celalalt.lei - rapid.lei), 3) + " lei/cutie"}</span>
        </div>
        <div class="awb-calc" style="flex:1 1 100%">
          ${[
            ["Arie carton / cutie", rapid.arieTotal, "m²"],
            ["Placă (carton)", rapid.cMaterial, "€/cutie"],
            ["Transport placă", rapid.cTransport, "€/cutie"],
            ["Cerneală", rapid.cCerneala, "€/cutie"],
            ["Manoperă", rapid.cManopera, "€/cutie"],
            ["Energie electrică", rapid.cEnergie, "€/cutie"],
            ["Setup, amortizat pe lot", rapid.cSetup, "€/cutie"],
            ["Ștanță, amortizată", rapid.cStanta, "€/cutie"],
            ["Cerneală consumată / cutie", rapid.gCerneala, "g"],
            ["Placa + transportul, din total", Math.round(rapid.ponderePlaca * 1000) / 10, "%"],
          ]
            .map(
              ([et, v, um]) => `<div class="awb-calc-rand"><span class="awb-calc-et">${esc(et)}</span>
                <span class="awb-calc-val">${esc(taieZerouri(v))} <span class="mic">${esc(um)}</span></span></div>`
            )
            .join("")}
        </div>
        ${rapid.alerte.length ? `<p class="mic" style="flex:1 1 100%;color:var(--danger,#b91c1c);margin:0">De verificat: ${esc(rapid.alerte.join("; "))}</p>` : ""}
      </div>`;

    // ---- Comparația celor două fluxuri, la cutia de referință -------------
    const capCmp = ["Componentă", "Formate + lipite (€/1000)", "Autoformare (€/1000)", "Diferență (€/1000)"];
    const linieCmp = (et, v1, v2) => [
      et, nr(v1 * 1000, 2), nr(v2 * 1000, 2),
      `<span${Math.abs(v2 - v1) < 1e-12 ? "" : ` style="color:var(--${v2 < v1 ? "success" : "danger,#b91c1c"})"`}>${nr((v2 - v1) * 1000, 2)}</span>`,
    ];
    const A1 = r.refLipire, A2 = r.refAuto;
    const randCmp = [
      linieCmp("Materie primă (carton)", A1.cMaterial, A2.cMaterial),
      linieCmp("Transport placă", A1.cTransport, A2.cTransport),
      linieCmp("Cerneală", A1.cCerneala, A2.cCerneala),
      linieCmp("Manoperă", A1.cManopera, A2.cManopera),
      linieCmp("Energie electrică", A1.cEnergie, A2.cEnergie),
      linieCmp("Setup / reglare (amortizat)", A1.cSetup, A2.cSetup),
      linieCmp("Ștanță (amortizare)", A1.cStanta, A2.cStanta),
    ];
    const totalCmp = [
      "<strong>TOTAL / 1000 cutii</strong>",
      `<strong>${nr(A1.total1000)} €</strong><br><span class="mic">${nr(A1.lei1000)} lei</span>`,
      `<strong>${nr(A2.total1000)} €</strong><br><span class="mic">${nr(A2.lei1000)} lei</span>`,
      `<strong>${nr(A2.total1000 - A1.total1000)} €</strong><br><span class="mic">${nr(A2.lei1000 - A1.lei1000)} lei</span>`,
    ];

    // ---- Tabelul tipurilor salvate ----------------------------------------
    const capPret = ["Tip de cutie", "Flux", "Placă (mm)", "Plăci / cutie",
      "Print (mm × mm × fețe × culori)", "Lot (cutii)",
      "TOTAL / cutie (lei)", "TOTAL / 1000 (lei)", "TOTAL / 1000 (€)"];
    const randPret = r.tipuri.map((x) => [
      `<strong>${esc(x.nume)}</strong>${x.alerte.length ? ` <span class="badge gri" title="${esc(x.alerte.join("; "))}">de verificat</span>` : ""}`,
      esc(x.etichetaLinie),
      `${nr(x.placa_lung, 0)} × ${nr(x.placa_lat, 0)}`,
      nr(x.placi, 0),
      `${nr(x.print_lung, 0)} × ${nr(x.print_inalt, 0)} × ${nr(x.fete, 0)} × ${nr(x.culori, 0)}`,
      nr(x.lot, 0),
      `<strong>${nr(x.lei, 3)}</strong>`,
      `<strong>${nr(x.lei1000)}</strong>`,
      nr(x.total1000),
    ]);

    // ---- Detalierea costului pe tip ---------------------------------------
    const capDet = ["Tip de cutie", "Carton (€/1000)", "Transport (€/1000)", "Cerneală (€/1000)",
      "Manoperă (€/1000)", "Energie (€/1000)", "Setup (€/1000)", "Ștanță (€/1000)",
      "TOTAL (€/1000)", "Placa + transport din total (%)"];
    const randDet = r.tipuri.map((x) => [
      `<strong>${esc(x.nume)}</strong>`,
      nr(x.cMaterial * 1000), nr(x.cTransport * 1000), nr(x.cCerneala * 1000),
      nr(x.cManopera * 1000), nr(x.cEnergie * 1000), nr(x.cSetup * 1000), nr(x.cStanta * 1000),
      `<strong>${nr(x.total1000)}</strong>`,
      nr(x.ponderePlaca * 100, 1),
    ]);

    // ---- Necesarul pentru loturile din tabel ------------------------------
    const capNec = ["Tip de cutie", "Lot (cutii)", "Plăci necesare", "Carton (m²)",
      "Cerneală (g)", "Transporturi", "Ore mașină", "Valoare lot (lei, cost)"];
    const randNec = r.tipuri.map((x) => [
      `<strong>${esc(x.nume)}</strong>`,
      nr(x.lot, 0), nr(Math.ceil(x.placiLot), 0), nr(x.m2Lot, 1),
      nr(x.gCernealaLot, 0), nr(x.transporturi, 2), nr(x.oreLot, 1),
      `<strong>${nr(x.valoareLot)}</strong>`,
    ]);
    const tn = r.total;
    const totalNecRand = [
      "<strong>TOTAL</strong>",
      `<strong>${nr(tn.lot, 0)}</strong>`,
      `<strong>${nr(Math.ceil(tn.placi), 0)}</strong>`,
      `<strong>${nr(tn.m2, 1)}</strong>`,
      `<strong>${nr(tn.cerneala, 0)}</strong>`,
      `<strong>${nr(a.placi_transport ? tn.placi / a.placi_transport : 0, 2)}</strong>`,
      `<strong>${nr(tn.ore, 1)}</strong>`,
      `<strong>${nr(tn.valoare)}</strong>`,
    ];

    // ---- Costul pe etape, ca referință ------------------------------------
    const blocEtape = (titlu, randuri, nota) => `
      <h3 class="awb-sect">${esc(titlu)}</h3>
      <div class="awb-calc">${randuri
        .map(([et, v, um, ex]) => `<div class="awb-calc-rand">
          <span class="awb-calc-et">${esc(et)}</span>
          <span class="awb-calc-val">${esc(taieZerouri(v))} <span class="mic">${esc(um)}</span></span>
          ${ex ? `<span class="mic awb-calc-nota">${esc(ex)}</span>` : ""}
        </div>`)
        .join("")}</div>
      ${nota ? `<p class="mic" style="margin:4px 0 0">${esc(nota)}</p>` : ""}`;

    const blocLinie = (L, extra) =>
      blocEtape("Linia „" + L.eticheta + "” — manoperă și energie", [
        ["Capacitate", L.capacitate, "cutii/oră", nr(L.viteza, 0) + " cutii/min × 60"],
        ["Manoperă", L.manopRon, "lei/oră", nr(L.operatori, 0) + " operatori × " + nr(a.cost_ora, 0) + " lei/oră"],
        ["Energie electrică", L.energieRon, "lei/oră", nr(L.kwh, 0) + " kWh/oră × " + nr(a.pret_energie, 2) + " lei/kWh"],
        ["Total procesare", L.totalRon, "lei/oră", nr(L.totalEur, 2) + " €/oră"],
        ["Cost procesare", L.per1000, "€/1000 buc", "manoperă " + nr(L.manop1000, 2) + " + energie " + nr(L.energie1000, 2)],
        ["Setup / reglare", L.setupRon, "lei", nr(a.setup_min, 0) + " min la același cost orar"],
      ].concat(extra || []), "");

    const etapeHtml =
      blocEtape("Placa de carton — ce intră în ea", [
        ["Preț carton", r.pretCartonM2, "€/m²", nr(a.pret_carton, 0) + " € / 1000 m² ÷ 1000"],
        ["Arie placă (dimensiunile implicite)", (a.placa_lung / 1000) * (a.placa_lat / 1000), "m²", nr(a.placa_lung, 0) + " × " + nr(a.placa_lat, 0) + " mm"],
        ["Cost transport per placă", r.transportPlaca, "€/placă", nr(a.transport_eur, 0) + " € ÷ " + nr(a.placi_transport, 0) + " plăci"],
        ["Placă livrată (material + transport)", r.refLipire.cMaterial + r.refLipire.cTransport, "€/cutie", "la " + nr(a.placi_cutie, 0) + " placă/cutie"],
      ], "Aria folosită în cost e cea a plăcii de la furnizor, nu desfășurata calculată din geometria cutiei — la fel ca în fișierul primit.") +
      blocEtape("Cerneala", [
        ["Preț cerneală", r.cernealaEurG, "€/g", nr(a.cerneala_eur, 2) + " €/litru, densitate " + nr(a.cerneala_dens, 2) + " g/ml"],
        ["Suprafață tipărită (implicit)", (a.print_lung / 1000) * (a.print_inalt / 1000) * a.print_fete, "m²/cutie", nr(a.print_lung, 0) + " × " + nr(a.print_inalt, 0) + " mm × " + nr(a.print_fete, 0) + " fețe"],
        ["Consum", r.refLipire.gCerneala, "g/cutie", nr(a.cerneala_g_m2, 2) + " g/m² × " + nr(a.print_culori, 0) + " culori"],
        ["Cost cerneală", r.refLipire.cCerneala * 1000, "€/1000 buc"],
      ], "") +
      blocLinie(r.L1) +
      blocLinie(r.L2, [
        ["Ștanță — cost per cutie", r.stantaBuc, "€/cutie", nr(a.stanta_eur, 0) + " € ÷ " + nr(a.stanta_viata, 0) + " cutii"],
        ["Ștanță — cost per 1000", r.stanta1000, "€/1000 buc"],
      ]);

    // ---- Tipurile de cutie (tabel editabil) --------------------------------
    const randuriTip = tipuri.concat(eAdmin ? [{
      nume: "", linie: "lipire", placa_lung: a.placa_lung, placa_lat: a.placa_lat,
      placi: a.placi_cutie, print_lung: a.print_lung, print_inalt: a.print_inalt,
      fete: a.print_fete, culori: a.print_culori, lot: a.lot,
    }] : []);
    const coloaneTip = [
      ["placa_lung", "Lungime placă (mm)"],
      ["placa_lat", "Lățime placă (mm)"],
      ["placi", "Plăci / cutie"],
      ["print_lung", "Print — lungime (mm)"],
      ["print_inalt", "Print — înălțime (mm)"],
      ["fete", "Fețe"],
      ["culori", "Culori"],
      ["lot", "Lot (cutii)"],
    ];
    const tipuriHtml = eAdmin
      ? `<form method="post" action="/calculator/cutii/tipuri">
          <div class="tabel-scroll"><table class="table">
            <thead><tr>
              <th>Tip de cutie</th><th>Flux</th>
              ${coloaneTip.map(([, et]) => `<th>${esc(et)}</th>`).join("")}
              <th>Șterge</th>
            </tr></thead>
            <tbody>${randuriTip
              .map((f, i) => `<tr>
                <td><input class="pungi-in pungi-text" type="text" name="t${i}_nume" value="${esc(String(f.nume))}" placeholder="cod / client"></td>
                <td><select class="pungi-in" name="t${i}_linie">${optLinie(f.linie)}</select></td>
                ${coloaneTip.map(([c]) => `<td><input class="pungi-in" type="number" step="any" name="t${i}_${c}" value="${esc(String(f[c]))}"></td>`).join("")}
                <td>${f.nume ? `<input type="checkbox" name="delt${i}" value="1">` : ""}</td>
              </tr>`)
              .join("")}</tbody>
          </table></div>
          <div class="form-actions"><button class="btn" type="submit">Salvează tipurile de cutie</button></div>
        </form>`
      : "";

    // ---- Formularul de asumpții --------------------------------------------
    // Galben = confirmat, bej = presupunere de corectat, gri = calculat.
    // Cele bej sunt tot date de intrare: fișierul-sursă cere explicit să fie
    // corectate, deci ar fi o greșeală să nu se poată atinge.
    const calculateHtml = (titluSectiune) => {
      const lista = CALCULATE[titluSectiune] || [];
      if (!lista.length) return "";
      return `<div class="awb-calc">${lista
        .map(([et, fn, um]) => `<div class="awb-calc-rand">
          <span class="awb-calc-et">${esc(et)}</span>
          <span class="awb-calc-val">${esc(taieZerouri(fn(r, a)))} <span class="mic">${esc(um || "")}</span></span>
        </div>`)
        .join("")}</div>`;
    };

    let campuriHtml = "";
    let sectiuneCurenta = null;
    for (const c of ASUMPTII) {
      if (c[0] === "sect") {
        campuriHtml += `</div>${calculateHtml(sectiuneCurenta)}<h3 class="awb-sect">${esc(c[1])}</h3><div class="awb-grid">`;
        sectiuneCurenta = c[1];
        continue;
      }
      const schimbat = a[c[0]] !== baza[c[0]];
      const clasa = c[4] === "dc" ? "awb-bej" : "awb-galben";
      const eticheta = `${esc(c[1])} <span class="mic">${esc(c[3] || "")}</span>${c[4] === "dc" ? ` <span class="mic pungi-dc">de confirmat</span>` : ""}`;
      campuriHtml += eAdmin
        ? `<label class="field ${clasa}${schimbat ? " awb-schimbat" : ""}"><span>${eticheta}</span>
            <input type="number" step="any" name="${esc(c[0])}" value="${esc(String(a[c[0]]))}"></label>`
        : `<div class="field ${clasa}"><span>${eticheta}</span><div class="pungi-ro">${esc(taieZerouri(a[c[0]]))}</div></div>`;
    }
    campuriHtml += `</div>${calculateHtml(sectiuneCurenta)}`;
    campuriHtml = ('<div class="awb-grid">' + campuriHtml).replace('<div class="awb-grid"></div>', "");

    const asumptiiHtml = eAdmin
      ? `<form method="post" action="/calculator/cutii/asumptii">${campuriHtml}
          <div class="form-actions"><button class="btn" type="submit">Salvează asumpțiile</button></div>
        </form>`
      : campuriHtml;

    // Cu 2 plăci pe cutie costul aproape se dublează, pentru că placa e
    // aproape tot costul — deci întrebarea asta merită pusă în față.
    const cuDouaPlaci = r.unTip(Object.assign({}, {
      nume: "2 plăci", linie: "lipire", placa_lung: a.placa_lung, placa_lat: a.placa_lat,
      print_lung: a.print_lung, print_inalt: a.print_inalt, fete: a.print_fete,
      culori: a.print_culori, lot: a.lot,
    }, { placi: 2 }));

    const body = `
      ${subnavCrm("/calculator", ctx.user)}
      ${selectorCalculator("/calculator/cutii")}
      <p class="mic" style="margin:0 0 12px;max-width:940px">
        Costul complet al unei cutii de carton, pe cele două fluxuri posibile:
        <b>formate + lipite</b> (două mașini) și <b>autoformare</b> (o mașină cu ștanță, fără lipire).
        Placa de carton și transportul ei fac <b>${nr(r.refLipire.ponderePlaca * 100, 1)}%</b> din cost, deci acolo se dă bătălia —
        diferența dintre cele două linii e de ${nr(Math.abs(r.refAuto.total1000 - r.refLipire.total1000), 2)} €/1000 cutii.
        Nu sunt incluse adezivul și amortizarea utilajelor. Toate cifrele vin din <a href="#asumptii">asumpțiile de jos</a>.
      </p>

      ${ctx.query && ctx.query.salvat ? `<div class="flash">Salvat.</div>` : ""}
      ${modificat.length
        ? `<div class="flash">Te uiți la un <b>scenariu</b>, nu la cifrele salvate: ${esc(modificat.join(", "))}.
           <a href="/calculator/cutii">Înapoi la cifrele firmei</a></div>`
        : ""}
      ${Number(a.placi_cutie) === 1
        ? `<div class="flash flash-rosu">Calculul presupune <b>o placă per cutie</b>. Dacă o cutie are nevoie de două,
           costul urcă de la ${nr(r.refLipire.lei, 2)} la <b>${nr(cuDouaPlaci.lei, 2)} lei/cutie</b> — e cea mai importantă
           cifră de confirmat cu producția.</div>`
        : ""}

      <h2 style="margin-top:10px">Calcul rapid pentru o cerere</h2>
      <p class="mic" style="margin:0 0 8px;max-width:900px">Dimensiunile unei cereri primite acum, fără să se salveze nimic.
        Adresa paginii ține tot calculul, deci linkul se poate trimite mai departe.</p>
      ${rapidHtml}
      ${rapidRez}

      <h2 style="margin-top:22px">Cele două fluxuri, la aceeași cutie</h2>
      <p class="mic" style="margin:0 0 8px">Cutia de referință din asumpții: placă ${nr(a.placa_lung, 0)} × ${nr(a.placa_lat, 0)} mm,
        ${nr(a.placi_cutie, 0)} placă/cutie, lot de ${nr(a.lot, 0)} cutii.</p>
      <div class="tabel-scroll">${table(capCmp, randCmp, { total: totalCmp })}</div>

      <h2 style="margin-top:22px">Tipurile de cutie salvate</h2>
      <p class="mic" style="margin:0 0 8px">Fiecare tip cu placa, printul și lotul lui. Setup-ul se amortizează pe lot, deci costul pe bucată scade cu cantitatea.</p>
      <div class="tabel-scroll">${table(capPret, randPret)}</div>

      <h3 class="awb-sect">Din ce se compune totalul</h3>
      <div class="tabel-scroll">${table(capDet, randDet)}</div>

      <h2 style="margin-top:22px">Necesar pentru loturi</h2>
      <p class="mic" style="margin:0 0 8px">Pentru loturile din tabelul de mai sus. Plăcile sunt rotunjite în sus.</p>
      <div class="tabel-scroll">${table(capNec, randNec, { total: totalNecRand })}</div>

      <h2 style="margin-top:22px">Costul pe etape</h2>
      <p class="mic" style="margin:0 0 8px">Cifrele intermediare, în unitatea naturală a fiecărei etape — de aici se construiește prețul pe cutie.</p>
      ${etapeHtml}

      ${eAdmin ? `<h2 style="margin-top:22px">Tipuri de cutie</h2>
        <p class="mic" style="margin:0 0 8px">Rândul gol de la final adaugă un tip nou; bifa de pe un rând existent îl șterge la salvare.</p>
        ${tipuriHtml}` : ""}

      <h2 id="asumptii" style="margin-top:22px">Asumpții</h2>
      <p class="awb-legenda mic">
        <span class="awb-pastila awb-pastila-galben"></span> confirmat de firmă &nbsp;
        <span class="awb-pastila awb-pastila-bej"></span> presupunere, de confirmat &nbsp;
        <span class="awb-pastila awb-pastila-gri"></span> calculat automat, nu se scrie
        ${eAdmin ? "" : " &nbsp;— doar un administrator le poate schimba."}
      </p>
      ${asumptiiHtml}

      <h2 style="margin-top:22px">Cum e făcut calculul</h2>
      <div class="explic" style="max-width:940px">
        <p><b>Placa, nu desfășurata.</b> Costul materialului se ia din aria plăcii de la furnizor
        (${nr(a.placa_lung, 0)} × ${nr(a.placa_lat, 0)} mm = ${nr((a.placa_lung / 1000) * (a.placa_lat / 1000), 4)} m²), nu din
        desfășurata calculată din geometria cutiei. Așa e și în fișierul primit: desfășurata era ținută doar ca verificare,
        pentru că plata se face pe placa livrată, cu tot cu ce se pierde la tăiere.</p>

        <p><b>Câte plăci intră într-o cutie</b> e cea mai grea întrebare din tot calculul. La o placă pe cutie iese
        ${nr(r.refLipire.lei, 2)} lei/cutie; la două, ${nr(cuDouaPlaci.lei, 2)} lei — aproape dublu, pentru că placa și transportul ei
        sunt ${nr(r.refLipire.ponderePlaca * 100, 1)}% din cost. Fișierul original avea și el rubrica asta deschisă.</p>

        <p><b>Transportul</b> se împarte pe plăci, nu pe cutii: ${nr(a.transport_eur, 0)} € un camion, ${nr(a.placi_transport, 0)} plăci în el
        → ${nr(r.transportPlaca, 3)} €/placă. Când o cutie ia mai multe plăci, ia și transportul lor.</p>

        <p><b>Cerneala.</b> Aria tipărită × consumul pe culoare (${nr(a.cerneala_g_m2, 2)} g/m²) × numărul de culori.
        La ${nr(a.print_culori, 0)} ${a.print_culori == 1 ? "culoare" : "culori"} și ${nr(a.print_fete, 0)} ${a.print_fete == 1 ? "față" : "fețe"} iese ${nr(r.refLipire.gCerneala, 4)} g/cutie,
        adică ${nr(r.refLipire.cCerneala * 1000, 2)} €/1000 cutii — practic nimic față de carton. Consumul de
        ${nr(a.cerneala_g_m2, 2)} g/m² și densitatea de ${nr(a.cerneala_dens, 2)} g/ml sunt presupuneri, nu cifre de la furnizor.</p>

        <p><b>Cele două fluxuri.</b> „Formate + lipite” merge cu ${nr(a.l1_viteza, 0)} cutii/min pe două mașini,
        ${nr(a.l1_operatori, 0)} operatori și ${nr(a.l1_energie_debit + a.l1_energie_formare, 0)} kWh/oră.
        „Autoformare” merge cu ${nr(a.l2_viteza, 0)} cutii/min pe o singură mașină, ${nr(a.l2_operatori, 0)} operatori și
        ${nr(a.l2_energie, 0)} kWh/oră, dar cară ștanța: ${nr(a.stanta_eur, 0)} € împărțiți la ${nr(a.stanta_viata, 0)} cutii =
        ${nr(r.stanta1000, 2)} €/1000. De-aia diferența dintre ele e de doar
        ${nr(Math.abs(r.refAuto.total1000 - r.refLipire.total1000), 2)} €/1000 cutii.</p>

        <p><b>De ce prețul scade cu cantitatea.</b> Reglarea mașinii costă ${nr(r.L1.setupRon)} lei
        (${nr(a.setup_min, 0)} min la ${nr(r.L1.totalRon)} lei/oră) și se plătește o singură dată per lot.
        Împărțită la ${nr(a.lot, 0)} cutii înseamnă ${nr(r.refLipire.cSetup * 1000, 2)} €/1000; împărțită la 500 de cutii,
        de zece ori mai mult.</p>

        <p><b>Ce NU e în calcul:</b> adezivul (clei de lipire) — scos explicit — și amortizarea utilajelor.
        Din utilaje apare doar energia electrică consumată. Transportul plăcii, în schimb, <b>este</b> inclus.</p>

        <p><b>Ce e de confirmat.</b> Valorile bej sunt presupuneri preluate din fișier: plăcile per cutie,
        costul și capacitatea unui transport, consumul și densitatea cernelii, prețul și durata de viață a ștanței,
        și mărimea lotului. Se pot corecta direct — de-aia n-au fost blocate.</p>

        <p><b>Marja</b> din calculul rapid e adaos peste cost: preț = cost × (1 + marjă). Nu e marjă din prețul de vânzare.</p>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Calculator cutii carton", active: "/crm", body }));
  });

  // ---- Salvările. Toate doar pentru admin: sunt cifrele cu care lucrează
  // toată firma, nu preferințele unui agent. -------------------------------
  router.post("/calculator/cutii/asumptii", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/cutii");
    await scrieAsumptii(ctx.body || {});
    return redirect(ctx.res, "/calculator/cutii?salvat=1#asumptii");
  });

  router.post("/calculator/cutii/tipuri", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/cutii");
    const b = ctx.body || {};
    const out = [];
    for (let i = 0; i < 200; i++) {
      if (b["t" + i + "_nume"] === undefined) continue;
      if (b["delt" + i]) continue;
      const nume = String(b["t" + i + "_nume"] || "").trim().slice(0, 80);
      if (!nume) continue;
      out.push({
        nume,
        linie: String(b["t" + i + "_linie"] || "lipire").toLowerCase() === "autoformare" ? "autoformare" : "lipire",
        placa_lung: numar(b["t" + i + "_placa_lung"]),
        placa_lat: numar(b["t" + i + "_placa_lat"]),
        placi: numar(b["t" + i + "_placi"]),
        print_lung: numar(b["t" + i + "_print_lung"]),
        print_inalt: numar(b["t" + i + "_print_inalt"]),
        fete: numar(b["t" + i + "_fete"]),
        culori: numar(b["t" + i + "_culori"]),
        lot: numar(b["t" + i + "_lot"]),
      });
    }
    await scrieJson(CHEIE_T, out);
    return redirect(ctx.res, "/calculator/cutii?salvat=1");
  });
}

module.exports = {
  register, calculeaza, citesteAsumptii, citesteTipuri,
  ASUMPTII, CAMPURI, IMPLICITE, LINII, TIPURI_IMPLICITE,
};
