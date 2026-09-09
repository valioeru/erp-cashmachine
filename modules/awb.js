"use strict";
// Calculatorul AWB — costul si pretul plicurilor AWB pe formatele C3/C4/C5/C6.
//
// De ce exista: agentul care da un pret la AWB avea nevoie de un fisier Excel
// pe care il tinea local. Aici e acelasi model, cu aceleasi formule, dar cu
// asumptiile tinute o singura data in baza de date — deci toti agentii dau
// acelasi pret, iar cand se schimba cursul sau pretul unei materii prime se
// schimba intr-un singur loc.
//
// Modelul are doua metode de calcul al materialului, tinute in paralel
// intentionat:
//   TOP-DOWN   — materialul e dedus rezidual din pretul cunoscut al C5
//                (46 lei/1000): pret - salariu - electricitate - cutie - pungi.
//                E ancorat in realitate, dar mosteneste orice e ascuns in acei
//                46 lei (inclusiv eventuala marja deja inclusa acolo).
//   BOTTOM-UP  — materialul e calculat din preturile si gramajele celor 4
//                straturi (CPE25 + hot melt + liner + CPE30). E curat teoretic,
//                dar depinde de densitatea CPE presupusa.
// Diferenta dintre ele (cateva procente) e afisata pe fata, ca sa se vada cat
// de mult se bat cap in cap — nu e ascunsa intr-o medie.
//
// Peste ambele se adauga laminarea separata (hot melt intre liner si CPE25, pe
// alta masina) si rebutul, care NU erau in cei 46 lei declarati initial.

const db = require("../lib/db");
const { esc, layout, table, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Datele de intrare, cu valorile din fisierul primit de la Cash Machine.
// Ordinea de aici e ordinea in care apar pe pagina.
const ASUMPTII = [
  ["sect", "1. Produsul de referință — C5 (date reale)"],
  ["c5_lungime", "Lungime reală plic C5 (direcția de avans)", 230, "mm"],
  ["c5_latime", "Lățime reală plic C5 (peste lățimea foliei)", 175, "mm"],
  ["c5_fire", "Număr fire (plicuri alăturate) pe lățimea foliei", 3, "fire"],
  ["c5_viteza", "Viteza mașinii la C5", 80, "buc/min"],
  ["c5_pret", "Preț producție C5 (dat)", 46, "lei / 1000 buc"],
  ["sect", "2. Folia utilizată"],
  ["folie_latime", "Lățime folie", 525, "mm"],
  ["sect", "3. Formate standard ISO 216 (hârtie „pură”, fără adaos)"],
  ["iso_c5_l", "C5 ISO — lățime", 162, "mm"],
  ["iso_c5_L", "C5 ISO — lungime", 229, "mm"],
  ["iso_c4_l", "C4 ISO — lățime", 229, "mm"],
  ["iso_c4_L", "C4 ISO — lungime", 324, "mm"],
  ["iso_c3_l", "C3 ISO — lățime", 324, "mm"],
  ["iso_c3_L", "C3 ISO — lungime", 458, "mm"],
  ["iso_c6_l", "C6 ISO — lățime", 114, "mm"],
  ["iso_c6_L", "C6 ISO — lungime", 162, "mm"],
  ["sect", "4. Curs valutar"],
  ["curs", "Curs de schimb", 4.5, "RON / USD"],
  ["sect", "5. Manoperă, electricitate, ambalare (linia principală)"],
  ["salariu_zi", "Salariu / zi, 1 FTE", 360, "RON"],
  ["minute_zi", "Timp lucru / zi", 420, "minute"],
  ["oameni_c5", "Număr oameni la linia C5", 2, "persoane"],
  ["salariu_1000", "Salariu / 1000 buc AWB (1 persoană)", 3.428571429, "lei/1000"],
  ["electricitate_1000", "Electricitate / 1000 buc", 0.66, "lei/1000"],
  ["cutie_1000", "Preț cutie AWB / 1000 buc", 0.6, "lei/1000"],
  ["pungi_1000", "Pungi ambalaj / 1000 buc AWB", 0.0045, "lei/1000"],
  ["sect", "6. Structura plicului — 4 straturi"],
  ["densitate_cpe", "Densitate folie CPE (presupusă)", 920, "kg/m³"],
  ["gros_cpe25", "Grosime CPE 25", 25, "microni"],
  ["gros_cpe30", "Grosime CPE 30", 30, "microni"],
  ["gramaj_hm", "Gramaj adeziv hot melt aplicat", 23, "g/m²"],
  ["gramaj_liner", "Gramaj liner", 41, "g/m²"],
  ["sect", "7. Laminare separată (hot melt între liner și CPE 25)"],
  ["lam_viteza", "Viteza mașinii de laminare", 40, "m/minut"],
  ["lam_kw", "Consum electric mașină laminare", 40, "kW/h"],
  ["pret_energie", "Preț energie electrică", 1, "lei/kWh"],
  ["lam_oameni", "Număr oameni la mașina de laminare", 1, "persoane"],
  ["sect", "8. Rebut"],
  ["rebut", "Rebut de producție", 1.5, "%"],
  ["sect", "9. Capacitate de producție planificată"],
  ["schimburi", "Număr schimburi / zi", 2, "schimburi"],
  ["schimb_ore", "Durata schimb — ore întregi", 6, "ore"],
  ["schimb_min", "Durata schimb — minute suplimentare", 45, "minute"],
  ["sect", "10. Prețuri materii prime (USD / kg)"],
  ["pret_cpe25", "CPE 25 microni", 1.49, "USD/kg"],
  ["pret_cpe30", "CPE 30 microni", 1.49, "USD/kg"],
  ["pret_hm", "Adeziv hot melt", 2.45, "USD/kg"],
  ["pret_liner", "Liner", 1.67, "USD/kg"],
  ["sect", "11. Marja dorită, pe format (adaos peste cost)"],
  ["marja_c3", "Marjă C3", 20, "%"],
  ["marja_c4", "Marjă C4", 20, "%"],
  ["marja_c5", "Marjă C5", 20, "%"],
  ["marja_c6", "Marjă C6", 20, "%"],
];

const CAMPURI = ASUMPTII.filter((a) => a[0] !== "sect");
const IMPLICITE = Object.fromEntries(CAMPURI.map((c) => [c[0], c[2]]));

// ---- Modelul de calcul ---------------------------------------------------
// O singura functie, care primeste asumptiile si intoarce TOT: cele patru
// formate cu costul lor pe ambele metode, plus ratele intermediare. Paginile
// de mai jos doar afiseaza ce iese de aici, ca sa nu existe doua locuri in
// care se calculeaza acelasi lucru altfel.
function calculeaza(a) {
  const n = (x) => Number(a[x]) || 0;
  const rebut = n("rebut") / 100;

  // Adaosul tehnologic (sudura/clapeta) e dedus din diferenta dintre C5-ul
  // real si C5 ISO, si se presupune FIX pe toate formatele. E o estimare:
  // dimensiunile reale ale C3/C4/C6 n-au fost masurate.
  const adaosLatime = n("c5_latime") - n("iso_c5_l");
  const adaosLungime = n("c5_lungime") - n("iso_c5_L");

  // Costurile date pe C5, si materialul ca rezidual din pretul cunoscut.
  const salariuOameni = n("salariu_1000") * n("oameni_c5");
  const materialRezidual =
    n("c5_pret") - salariuOameni - n("electricitate_1000") - n("cutie_1000") - n("pungi_1000");

  // Viteza de avans a foliei e constanta indiferent de format — masina trage
  // folia la fel de repede, doar cate plicuri ies din ea difera.
  const vitezaAvans = n("c5_lungime") * (n("c5_viteza") / (n("c5_fire") || 1));
  const rataMaterial = materialRezidual / ((n("c5_latime") * n("c5_lungime")) || 1);

  // Gramajele celor 4 straturi, in g/m2.
  const gramaje = {
    cpe25: (n("densitate_cpe") * n("gros_cpe25")) / 1000,
    cpe30: (n("densitate_cpe") * n("gros_cpe30")) / 1000,
    hm: n("gramaj_hm"),
    liner: n("gramaj_liner"),
  };
  const preturiRon = {
    cpe25: n("pret_cpe25") * n("curs"),
    cpe30: n("pret_cpe30") * n("curs"),
    hm: n("pret_hm") * n("curs"),
    liner: n("pret_liner") * n("curs"),
  };
  // lei pe mm2 de folie si kg pe mm2, pentru fiecare strat.
  const leiMm2 = {};
  const kgMm2 = {};
  for (const k of ["cpe25", "cpe30", "hm", "liner"]) {
    leiMm2[k] = (gramaje[k] * preturiRon[k]) / 1000000;
    kgMm2[k] = gramaje[k] / 1000000;
  }

  const timpDisponibil = n("schimburi") * (n("schimb_ore") * 60 + n("schimb_min"));
  const salariuMinut = n("minute_zi") ? n("salariu_zi") / n("minute_zi") : 0;

  const defFormate = [
    ["C3", "iso_c3_l", "iso_c3_L", "marja_c3"],
    ["C4", "iso_c4_l", "iso_c4_L", "marja_c4"],
    ["C5", "iso_c5_l", "iso_c5_L", "marja_c5"],
    ["C6", "iso_c6_l", "iso_c6_L", "marja_c6"],
  ];

  // Timpul C5 e referinta: salariul si electricitatea celorlalte formate se
  // scaleaza proportional cu timpul de masina, nu raman fixe la 1000 buc.
  const c5LatReal = n("iso_c5_l") + adaosLatime;
  const c5LungReal = n("iso_c5_L") + adaosLungime;
  const c5Fire = Math.floor(n("folie_latime") / (c5LatReal || 1)) || 1;
  const c5Cicluri = vitezaAvans / (c5LungReal || 1);
  const c5Timp1000 = 1000 / ((c5Cicluri * c5Fire) || 1);

  const formate = defFormate.map(([nume, chLat, chLung, chMarja]) => {
    const isoLat = n(chLat);
    const isoLung = n(chLung);
    const latReal = isoLat + adaosLatime;
    const lungReal = isoLung + adaosLungime;
    // Cate plicuri incap alaturate pe latimea fixa a foliei. Restul latimii se
    // pierde ca deseu si e platit tot din cost — de-aia aria consumata se
    // calculeaza pe INTREAGA latime a foliei, nu pe latimea plicurilor.
    const fire = Math.floor(n("folie_latime") / (latReal || 1));
    const cicluri = lungReal ? vitezaAvans / lungReal : 0;
    const viteza = cicluri * fire;
    const timp1000 = viteza ? 1000 / viteza : 0;
    const arie1000 = fire ? (n("folie_latime") * lungReal) / fire : 0;

    const material = rataMaterial * arie1000;
    const raport = c5Timp1000 ? timp1000 / c5Timp1000 : 0;
    const salariu = salariuOameni * raport;
    const electricitate = n("electricitate_1000") * raport;
    const cutie = n("cutie_1000");
    const pungi = n("pungi_1000");
    const subtotal = material + salariu + electricitate + cutie + pungi;

    // Laminarea: aceeasi lungime de web ca la masina principala, dar cu viteza
    // masinii de laminat. Lungimea e in mm, viteza in m/min — de aici /1000.
    const timpLam = fire && n("lam_viteza") ? lungReal / fire / n("lam_viteza") : 0;
    const salariuLam = salariuMinut * n("lam_oameni") * timpLam;
    const elLam = n("lam_kw") * (timpLam / 60) * n("pret_energie");
    const totalGeneral = subtotal + salariuLam + elLam;
    // Costul s-a cheltuit si pe bucatile rebutate, deci costul per bucata BUNA
    // e mai mare cu exact procentul de rebut.
    const totalRebut = rebut < 1 ? totalGeneral / (1 - rebut) : 0;

    // Bottom-up: acelasi consum de folie, dar cost din straturi.
    const straturi = {};
    let materialBu = 0;
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) {
      straturi[k] = leiMm2[k] * arie1000;
      materialBu += straturi[k];
    }
    const subtotalBu = materialBu + salariu + electricitate + cutie + pungi;
    const totalBu = subtotalBu + salariuLam + elLam;
    const totalBuRebut = rebut < 1 ? totalBu / (1 - rebut) : 0;

    const marja = Number(a[chMarja]) || 0;
    const pretVanzare = totalRebut * (1 + marja / 100);

    // Consum de materie prima, kg la 1000 buc.
    const kg1000 = {};
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) kg1000[k] = kgMm2[k] * arie1000;

    return {
      nume, isoLat, isoLung, latReal, lungReal, fire, cicluri, viteza, timp1000, arie1000,
      material, salariu, electricitate, cutie, pungi, subtotal,
      timpLam, salariuLam, elLam, totalGeneral, totalRebut,
      straturi, materialBu, subtotalBu, totalBu, totalBuRebut,
      difBu: totalRebut - totalBuRebut,
      difBuProc: totalRebut ? ((totalRebut - totalBuRebut) / totalRebut) * 100 : 0,
      marja, pretVanzare, pretBuc: totalRebut / 1000, pretVanzareBuc: pretVanzare / 1000,
      kg1000,
    };
  });

  const c5 = formate.find((f) => f.nume === "C5");
  for (const f of formate) f.difC5 = c5 && c5.totalRebut ? ((f.totalRebut - c5.totalRebut) / c5.totalRebut) * 100 : 0;

  return {
    adaosLatime, adaosLungime, salariuOameni, materialRezidual, vitezaAvans, rataMaterial,
    gramaje, preturiRon, leiMm2, kgMm2, timpDisponibil, salariuMinut, rebut, formate, c5,
    // Verificarea din fisier: subtotalul C5 fara laminare trebuie sa dea exact
    // pretul declarat. Daca nu da, cineva a schimbat o asumptie care nu se leaga.
    verificaC5: c5 ? Math.abs(c5.subtotal - n("c5_pret")) < 0.005 : false,
  };
}

// Din stocul de materii prime (kg), cate bucati ies pe fiecare format.
// Materialul care se termina primul limiteaza productia — pe el il numim.
function dinStoc(rez, stoc, timpDisponibil, rebut) {
  const NUME = { cpe25: "CPE 25", cpe30: "CPE 30", hm: "Hot melt", liner: "Liner" };
  return rez.formate.map((f) => {
    const peMaterial = {};
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) {
      const consum1000 = f.kg1000[k];
      peMaterial[k] = consum1000 > 0 ? (Number(stoc[k]) || 0) / consum1000 * 1000 : 0;
    }
    let limitativ = null;
    let maxProduse = Infinity;
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) {
      if (peMaterial[k] < maxProduse) { maxProduse = peMaterial[k]; limitativ = k; }
    }
    if (!isFinite(maxProduse)) maxProduse = 0;
    const maxBune = maxProduse * (1 - rebut);
    const zile = timpDisponibil > 0 ? (maxProduse * f.timp1000) / (1000 * timpDisponibil) : 0;
    return {
      nume: f.nume, kg1000: f.kg1000, peMaterial, maxProduse, maxBune,
      limitativ: limitativ ? NUME[limitativ] : "—", cutii: maxBune / 1000, zile,
    };
  });
}

// Din numarul de bucati BUNE cerute, cata materie prima si cat costa.
// „De produs" e mai mare decat necesarul, fiindca o parte iese rebut.
function necesar(rez, cantitati, rebut) {
  const randuri = rez.formate.map((f) => {
    const bune = Number(cantitati[f.nume]) || 0;
    const deProdus = rebut < 1 ? bune / (1 - rebut) : 0;
    const kg = {};
    let costMaterial = 0;
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) {
      kg[k] = (f.kg1000[k] * deProdus) / 1000;
      costMaterial += kg[k] * rez.preturiRon[k];
    }
    const salEl = ((f.salariu + f.electricitate) * deProdus) / 1000;
    const ambalare = ((f.cutie + f.pungi) * deProdus) / 1000;
    const laminare = ((f.salariuLam + f.elLam) * deProdus) / 1000;
    const total = costMaterial + salEl + ambalare + laminare;
    return {
      nume: f.nume, bune, deProdus, kg, costMaterial, salEl, ambalare, laminare, total,
      peBuc: bune > 0 ? total / bune : 0,
      pretVanzare: total * (1 + f.marja / 100),
    };
  });
  const t = { bune: 0, deProdus: 0, kg: { cpe25: 0, cpe30: 0, hm: 0, liner: 0 }, costMaterial: 0, salEl: 0, ambalare: 0, laminare: 0, total: 0, pretVanzare: 0 };
  for (const r of randuri) {
    t.bune += r.bune; t.deProdus += r.deProdus; t.costMaterial += r.costMaterial;
    t.salEl += r.salEl; t.ambalare += r.ambalare; t.laminare += r.laminare;
    t.total += r.total; t.pretVanzare += r.pretVanzare;
    for (const k of ["cpe25", "cpe30", "hm", "liner"]) t.kg[k] += r.kg[k];
  }
  return { randuri, total: t };
}

// ---- Asumptiile din baza de date -----------------------------------------
// Se tin intr-un singur rand JSON in setari_app: sunt vreo 40 de numere care
// se citesc mereu impreuna, deci n-are rost un tabel separat.
const CHEIE = "awb_asumptii";

async function citesteAsumptii() {
  const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(CHEIE).catch(() => null);
  let salvate = {};
  if (r && r.valoare) {
    try { salvate = JSON.parse(r.valoare) || {}; } catch { salvate = {}; }
  }
  const out = {};
  for (const c of CAMPURI) {
    const v = salvate[c[0]];
    out[c[0]] = v === undefined || v === null || v === "" ? c[2] : Number(v);
    if (!isFinite(out[c[0]])) out[c[0]] = c[2];
  }
  return out;
}

async function scrieAsumptii(val) {
  const curat = {};
  for (const c of CAMPURI) {
    const v = Number(val[c[0]]);
    curat[c[0]] = isFinite(v) ? v : c[2];
  }
  const acum = new Date().toISOString();
  const j = JSON.stringify(curat);
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(CHEIE).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(j, acum, CHEIE);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(CHEIE, j, acum);
  return curat;
}

// ---- Formatare -----------------------------------------------------------
const nr = (v, z) => {
  const x = Number(v);
  if (!isFinite(x)) return "—";
  return x.toLocaleString("ro-RO", { minimumFractionDigits: z === undefined ? 2 : z, maximumFractionDigits: z === undefined ? 2 : z });
};
const lei = (v, z) => nr(v, z) + " lei";
const proc = (v) => (Number(v) >= 0 ? "+" : "") + nr(v, 1) + "%";

function register(router) {
  router.get("/calculator/awb", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const baza = await citesteAsumptii();

    // Orice asumptie poate fi suprascrisa din adresa paginii, fara sa se
    // salveze — asa se poate trimite un link cu un scenariu ("ce iese daca
    // urca cursul la 5,1") fara sa se schimbe cifrele pentru toata lumea.
    const a = Object.assign({}, baza);
    let modificat = [];
    for (const c of CAMPURI) {
      const q = ctx.query && ctx.query[c[0]];
      if (q !== undefined && q !== "") {
        const v = Number(String(q).replace(",", "."));
        if (isFinite(v) && v !== baza[c[0]]) { a[c[0]] = v; modificat.push(c[1]); }
      }
    }

    const r = calculeaza(a);

    // Cantitatile celor doua calculatoare vin tot din adresa.
    const stoc = {};
    for (const [k, q] of [["cpe25", "stoc_cpe25"], ["cpe30", "stoc_cpe30"], ["hm", "stoc_hm"], ["liner", "stoc_liner"]]) {
      const brut = ctx.query && ctx.query[q];
      const v = brut === undefined || brut === "" ? NaN : Number(String(brut).replace(",", "."));
      stoc[k] = isFinite(v) && v >= 0 ? v : 1000;
    }
    const cant = {};
    for (const f of ["C3", "C4", "C5", "C6"]) {
      const brut = ctx.query && ctx.query["nec_" + f];
      const v = brut === undefined || brut === "" ? NaN : Number(String(brut).replace(",", "."));
      cant[f] = isFinite(v) && v >= 0 ? v : 10000;
    }
    const sStoc = dinStoc(r, stoc, r.timpDisponibil, r.rebut);
    const sNec = necesar(r, cant, r.rebut);

    const qs = (extra) => {
      const p = new URLSearchParams();
      for (const c of CAMPURI) if (a[c[0]] !== baza[c[0]]) p.set(c[0], String(a[c[0]]));
      for (const [k, v] of Object.entries(extra || {})) p.set(k, String(v));
      const s = p.toString();
      return s ? "?" + s : "";
    };
    const ascunse = () =>
      CAMPURI.filter((c) => a[c[0]] !== baza[c[0]])
        .map((c) => `<input type="hidden" name="${esc(c[0])}" value="${esc(String(a[c[0]]))}">`)
        .join("");

    // ---- Tabelul principal: costul si pretul pe format ---------------------
    // Tabelul pe care il vede agentul: pretul intai, restul dupa. Defalcarea
    // costului sta separat, mai jos — cine da un pret n-are nevoie sa se uite
    // prin sapte coloane ca sa ajunga la cifra care-l intereseaza.
    const capPret = ["Format", "Dimensiune reală (mm)", "COST cu rebut (lei/1000)", "Cost (lei/buc)",
      "Marjă", "PREȚ (lei/1000)", "Preț (lei/buc)", "vs. C5"];
    const randPret = r.formate.map((f) => [
      `<strong>${esc(f.nume)}</strong>`,
      `${nr(f.latReal, 0)} × ${nr(f.lungReal, 0)}`,
      `<strong>${nr(f.totalRebut)}</strong>`,
      nr(f.pretBuc, 4),
      `<span class="mic">${nr(f.marja, 0)}%</span>`,
      `<strong style="color:var(--success);font-size:15px">${nr(f.pretVanzare)}</strong>`,
      `<strong style="color:var(--success)">${nr(f.pretVanzareBuc, 4)}</strong>`,
      f.nume === "C5" ? "—" : proc(f.difC5),
    ]);

    // Defalcarea: din ce se face costul de mai sus.
    const capDef = ["Format", "Fire pe folie", "Viteză (buc/min)", "Timp/1000 buc (min)",
      "Material (lei/1000)", "Manoperă + energie (lei/1000)", "Ambalare (lei/1000)",
      "Laminare (lei/1000)", "Subtotal fără laminare", "TOTAL cu laminare", "TOTAL cu rebut"];
    const randDef = r.formate.map((f) => [
      `<strong>${esc(f.nume)}</strong>`,
      String(f.fire),
      nr(f.viteza, 1),
      nr(f.timp1000, 2),
      nr(f.material),
      nr(f.salariu + f.electricitate),
      nr(f.cutie + f.pungi, 3),
      nr(f.salariuLam + f.elLam),
      nr(f.subtotal),
      nr(f.totalGeneral),
      `<strong>${nr(f.totalRebut)}</strong>`,
    ]);

    // ---- Bottom-up: aceeasi marfa, cost calculat din straturi -------------
    const capBu = ["Format", "Arie folie (mm²/1000 buc)", "CPE 25", "CPE 30",
      "Hot melt", "Liner", "Material bottom-up (lei/1000)",
      "TOTAL cu rebut (lei/1000)", "Top-down (lei/1000)", "Diferență"];
    const randBu = r.formate.map((f) => [
      `<strong>${esc(f.nume)}</strong>`,
      nr(f.arie1000, 0),
      nr(f.straturi.cpe25),
      nr(f.straturi.cpe30),
      nr(f.straturi.hm),
      nr(f.straturi.liner),
      `<strong>${nr(f.materialBu)}</strong>`,
      `<strong>${nr(f.totalBuRebut)}</strong>`,
      nr(f.totalRebut),
      `${nr(f.difBu)} lei <span class="mic">(${nr(f.difBuProc, 1)}%)</span>`,
    ]);

    // ---- Calculatorul din stoc --------------------------------------------
    const capStoc = ["Format", "CPE 25 (kg/1000)", "CPE 30 (kg/1000)",
      "Hot melt (kg/1000)", "Liner (kg/1000)",
      "Max produse (buc)", "Se termină primul", "Max BUNE (buc)",
      "Cutii", "Zile până la epuizare"];
    const randStoc = sStoc.map((s) => [
      `<strong>${esc(s.nume)}</strong>`,
      nr(s.kg1000.cpe25, 3), nr(s.kg1000.cpe30, 3), nr(s.kg1000.hm, 3), nr(s.kg1000.liner, 3),
      nr(s.maxProduse, 0),
      `<span class="badge gri">${esc(s.limitativ)}</span>`,
      `<strong>${nr(s.maxBune, 0)}</strong>`,
      nr(s.cutii, 0),
      nr(s.zile, 1),
    ]);

    // ---- Calculatorul de necesar ------------------------------------------
    const capNec = ["Format", "Necesar (buc bune)", "De produs (cu rebut)",
      "CPE 25 (kg)", "CPE 30 (kg)", "Hot melt (kg)",
      "Liner (kg)", "Material (lei)", "Manoperă+energie (lei)",
      "Ambalare (lei)", "Laminare (lei)",
      "TOTAL cost (lei)", "Cost/buc", "Preț cu marjă (lei)"];
    const randNec = sNec.randuri.map((x) => [
      `<strong>${esc(x.nume)}</strong>`,
      nr(x.bune, 0), nr(x.deProdus, 0),
      nr(x.kg.cpe25, 2), nr(x.kg.cpe30, 2), nr(x.kg.hm, 2), nr(x.kg.liner, 2),
      nr(x.costMaterial), nr(x.salEl), nr(x.ambalare), nr(x.laminare),
      `<strong>${nr(x.total)}</strong>`,
      nr(x.peBuc, 4),
      `<strong style="color:var(--success)">${nr(x.pretVanzare)}</strong>`,
    ]);
    const t = sNec.total;
    randNec.push([
      "<strong>TOTAL de comandat</strong>",
      `<strong>${nr(t.bune, 0)}</strong>`, `<strong>${nr(t.deProdus, 0)}</strong>`,
      `<strong>${nr(t.kg.cpe25, 2)}</strong>`, `<strong>${nr(t.kg.cpe30, 2)}</strong>`,
      `<strong>${nr(t.kg.hm, 2)}</strong>`, `<strong>${nr(t.kg.liner, 2)}</strong>`,
      `<strong>${nr(t.costMaterial)}</strong>`, `<strong>${nr(t.salEl)}</strong>`,
      `<strong>${nr(t.ambalare)}</strong>`, `<strong>${nr(t.laminare)}</strong>`,
      `<strong>${nr(t.total)}</strong>`, "—",
      `<strong style="color:var(--success)">${nr(t.pretVanzare)}</strong>`,
    ]);

    // ---- Formularul de asumptii -------------------------------------------
    let campuriHtml = "";
    for (const c of ASUMPTII) {
      if (c[0] === "sect") { campuriHtml += `</div><h3 class="awb-sect">${esc(c[1])}</h3><div class="awb-grid">`; continue; }
      const schimbat = a[c[0]] !== baza[c[0]];
      campuriHtml += `<label class="field${schimbat ? " awb-schimbat" : ""}"><span>${esc(c[1])} <span class="mic">${esc(c[3] || "")}</span></span>
        <input type="number" step="any" name="${esc(c[0])}" value="${esc(String(a[c[0]]))}"></label>`;
    }
    campuriHtml = ("<div class=\"awb-grid\">" + campuriHtml + "</div>").replace("<div class=\"awb-grid\"></div>", "");

    const body = `
      ${subnavCrm("/calculator/awb", ctx.user)}
      <h1 style="margin:6px 0 2px">Calculator AWB — C3 / C4 / C5 / C6</h1>
      <p class="mic" style="margin:0 0 14px;max-width:900px">
        Costul și prețul plicurilor AWB, pe cele patru formate. Modelul pornește de la prețul cunoscut al C5
        (${nr(a.c5_pret)} lei/1000) și îl scalează pe celelalte formate după suprafața de folie consumată.
        Toate cifrele se recalculează din <a href="#asumptii">asumpțiile de jos</a>.
      </p>

      ${
        modificat.length
          ? `<div class="flash">Te uiți la un <b>scenariu</b>, nu la cifrele salvate: ${esc(modificat.join(", "))}.
             <a href="/calculator/awb">Înapoi la cifrele firmei</a></div>`
          : ""
      }
      ${
        r.verificaC5
          ? `<p class="mic" style="color:var(--success)">✓ Verificare: subtotalul C5 fără laminare dă exact ${nr(a.c5_pret)} lei/1000, prețul declarat. Modelul se leagă.</p>`
          : `<p class="mic" style="color:var(--danger)">⚠ Subtotalul C5 fără laminare (${nr(r.c5 ? r.c5.subtotal : 0)} lei/1000) nu mai coincide cu prețul declarat (${nr(a.c5_pret)}). O asumpție a fost schimbată și modelul nu se mai leagă — verifică secțiunea 5.</p>`
      }

      <h2>Cost și preț pe format</h2>
      ${table(capPret, randPret)}

      <h3 style="margin:18px 0 6px">Din ce se compune costul</h3>
      <div class="tabel-lat">${table(capDef, randDef)}</div>
      <p class="explic">
        <b>Material</b> e dedus rezidual din prețul C5: din cei ${nr(a.c5_pret)} lei/1000 se scad manopera, energia și ambalarea,
        iar ce rămâne e folia. Se scalează pe celelalte formate cu aria de folie consumată — inclusiv fâșia care se pierde
        pe lățime când firele nu acoperă toți cei ${nr(a.folie_latime, 0)} mm.
        <b>Laminarea</b> (hot melt între liner și CPE 25, pe mașină separată) <b>nu era</b> în prețul de ${nr(a.c5_pret)} lei —
        e cost nou, adăugat aici. <b>Rebutul</b> de ${nr(a.rebut, 1)}% se aplică la final: costul s-a cheltuit și pe bucățile
        rebutate, deci costul unei bucăți BUNE e mai mare. <b>Marja</b> e adaos peste cost (preț = cost × (1 + marjă)).
      </p>

      <h2>Verificare: același cost, calculat din straturi</h2>
      <p class="mic" style="max-width:900px">
        Aceeași marfă, dar cu materialul calculat direct din prețurile și gramajele celor patru straturi
        (CPE 25 + hot melt + liner + CPE 30), fără să treacă prin prețul de ${nr(a.c5_pret)} lei. Dacă cele două metode
        dau aproape la fel, modelul e sănătos. Diferența rămasă vine din marja deja inclusă în cei ${nr(a.c5_pret)} lei,
        din deșeu suplimentar, sau din densitatea CPE presupusă (${nr(a.densitate_cpe, 0)} kg/m³, neconfirmată).
      </p>
      <div class="tabel-lat">${table(capBu, randBu)}</div>

      <h2 id="stoc">Din stocul de materie primă, câte AWB ies</h2>
      <form class="filtre" method="get" action="/calculator/awb#stoc">
        ${ascunse()}
        <input type="hidden" name="nec_C3" value="${esc(String(cant.C3))}">
        <input type="hidden" name="nec_C4" value="${esc(String(cant.C4))}">
        <input type="hidden" name="nec_C5" value="${esc(String(cant.C5))}">
        <input type="hidden" name="nec_C6" value="${esc(String(cant.C6))}">
        <label class="mic">CPE 25 (kg) <input type="number" step="any" name="stoc_cpe25" value="${esc(String(stoc.cpe25))}" style="width:110px"></label>
        <label class="mic">CPE 30 (kg) <input type="number" step="any" name="stoc_cpe30" value="${esc(String(stoc.cpe30))}" style="width:110px"></label>
        <label class="mic">Hot melt (kg) <input type="number" step="any" name="stoc_hm" value="${esc(String(stoc.hm))}" style="width:110px"></label>
        <label class="mic">Liner (kg) <input type="number" step="any" name="stoc_liner" value="${esc(String(stoc.liner))}" style="width:110px"></label>
        <button class="btn small" type="submit">Calculează</button>
      </form>
      <div class="tabel-lat">${table(capStoc, randStoc)}</div>
      <p class="explic">
        Materialul care se termină primul limitează producția — el e cel numit în coloana „Se termină primul".
        <b>Max BUNE</b> = max produse × (1 − ${nr(a.rebut, 1)}% rebut). <b>Zilele</b> sunt la capacitatea planificată
        (${nr(a.schimburi, 0)} schimburi × ${nr(a.schimb_ore, 0)}h${nr(a.schimb_min, 0)} = ${nr(r.timpDisponibil, 0)} min/zi),
        dacă s-ar produce neîntrerupt doar formatul acela. Nu ține cont de laminarea separată — se presupune că nu ea e gâtul de sticlă.
      </p>

      <h2 id="necesar">Din câte AWB îmi trebuie, cât material și cât mă costă</h2>
      <form class="filtre" method="get" action="/calculator/awb#necesar">
        ${ascunse()}
        <input type="hidden" name="stoc_cpe25" value="${esc(String(stoc.cpe25))}">
        <input type="hidden" name="stoc_cpe30" value="${esc(String(stoc.cpe30))}">
        <input type="hidden" name="stoc_hm" value="${esc(String(stoc.hm))}">
        <input type="hidden" name="stoc_liner" value="${esc(String(stoc.liner))}">
        ${["C3", "C4", "C5", "C6"].map((f) => `<label class="mic">${f} (buc) <input type="number" step="1" name="nec_${f}" value="${esc(String(cant[f]))}" style="width:120px"></label>`).join("")}
        <button class="btn small" type="submit">Calculează</button>
      </form>
      <div class="tabel-lat">${table(capNec, randNec)}</div>
      <p class="explic">
        Scrii câte bucăți <b>bune</b> îți trebuie. „De produs" e mai mult, fiindcă ${nr(a.rebut, 1)}% iese rebut —
        materia primă și costurile se calculează pe cantitatea reală care trece prin mașină, nu pe necesar.
        Ultima coloană e prețul cu marja de pe fiecare format, ca să ai direct cifra de pus în ofertă.
      </p>

      <h2 id="asumptii">Asumpții și prețuri</h2>
      <p class="mic" style="max-width:900px">
        De aici se schimbă tot ce e mai sus. Apeși <b>Recalculează</b> și vezi rezultatul fără să salvezi —
        adresa paginii ține scenariul, deci îl poți trimite mai departe.
        ${eAdmin ? "Butonul <b>Salvează pentru toată firma</b> face din aceste cifre baza pe care o văd toți agenții." : "Doar administratorul poate salva cifrele pentru toată firma."}
      </p>
      <form class="form" method="get" action="/calculator/awb#asumptii" style="max-width:1100px">
        <input type="hidden" name="stoc_cpe25" value="${esc(String(stoc.cpe25))}">
        <input type="hidden" name="stoc_cpe30" value="${esc(String(stoc.cpe30))}">
        <input type="hidden" name="stoc_hm" value="${esc(String(stoc.hm))}">
        <input type="hidden" name="stoc_liner" value="${esc(String(stoc.liner))}">
        ${["C3", "C4", "C5", "C6"].map((f) => `<input type="hidden" name="nec_${f}" value="${esc(String(cant[f]))}">`).join("")}
        ${campuriHtml}
        <div class="form-actions">
          <button class="btn" type="submit">Recalculează</button>
          <a class="btn secondary" href="/calculator/awb">Înapoi la cifrele salvate</a>
        </div>
      </form>
      ${
        eAdmin
          ? `<form method="post" action="/calculator/awb/salveaza" style="margin-top:-6px"
                   onsubmit="return confirm('Salvezi aceste cifre ca bază pentru toată firma? Toți agenții vor calcula cu ele.')">
               ${CAMPURI.map((c) => `<input type="hidden" name="${esc(c[0])}" value="${esc(String(a[c[0]]))}">`).join("")}
               <button class="btn" type="submit">Salvează pentru toată firma</button>
               <span class="mic"> — cifrele de mai sus devin baza pentru toți agenții.</span>
             </form>`
          : ""
      }

      <h2>Cum e făcut calculul</h2>
      <div class="explic" style="max-width:900px">
        <p><b>Dimensiuni.</b> Formatele ISO sunt hârtia „pură". Plicul real e mai mare cu adaosul tehnologic
        (sudură/clapetă), dedus din C5-ul real: <b>+${nr(r.adaosLatime, 0)} mm</b> pe lățime și
        <b>+${nr(r.adaosLungime, 0)} mm</b> pe lungime. Acest adaos e presupus <b>același</b> pe C3, C4 și C6 —
        dimensiunile lor reale sunt estimate, nu măsurate.</p>

        <p><b>Viteză și risipă.</b> Viteza de avans a foliei e constantă, ${nr(r.vitezaAvans, 0)} mm/min, indiferent de format —
        mașina trage folia la fel, doar câte plicuri ies din ea diferă. Lățimea foliei e fixă la ${nr(a.folie_latime, 0)} mm și
        nu se poate optimiza. Numărul de fire = partea întreagă din ${nr(a.folie_latime, 0)} / lățimea reală; ce rămâne pe lățime
        se pierde ca deșeu și <b>se plătește</b> — de-aia materialul se calculează pe toată lățimea foliei.</p>

        <p><b>Straturile.</b> CPE 25 + adeziv hot melt + liner + CPE 30. Hârtia/packing list-ul intră liber între cele două folii
        CPE și nu e un strat cu cost. Adezivul și linerul se aplică pe toată suprafața, nu doar pe clapetă.
        Gramajul CPE = densitate × grosime: ${nr(r.gramaje.cpe25, 1)} g/m² la ${nr(a.gros_cpe25, 0)} microni și
        ${nr(r.gramaje.cpe30, 1)} g/m² la ${nr(a.gros_cpe30, 0)} microni.</p>

        <p><b>Manoperă.</b> ${nr(a.salariu_zi, 0)} lei/zi la ${nr(a.minute_zi, 0)} min/zi, cu ${nr(a.oameni_c5, 0)} oameni la linie.
        Salariul și electricitatea <b>se scalează cu timpul de mașină</b>, nu rămân fixe la 1000 buc. Cutia și pungile sunt
        presupuse constante la 1000 buc pe toate formatele — simplificare.</p>

        <p><b>Ce e de verificat.</b> Densitatea CPE (${nr(a.densitate_cpe, 0)} kg/m³) e o valoare tipică pentru folie PE,
        neconfirmată. Dimensiunile reale ale C3/C4/C6 sunt estimate. Rebutul e presupus același pe toate formatele.
        Nu sunt incluse costuri fixe de schimbare de format, mentenanță sau opriri.</p>

        <p><b>Marja</b> e adaos peste cost: preț = cost × (1 + marjă). Nu e marjă din prețul de vânzare.
        La ${nr(r.c5 ? r.c5.marja : 0, 0)}% adaos, marja reală din preț e
        ${nr(r.c5 && r.c5.pretVanzare ? ((r.c5.pretVanzare - r.c5.totalRebut) / r.c5.pretVanzare) * 100 : 0, 1)}%.</p>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Calculator AWB", active: "/crm", body }));
  });

  // Salvarea asumptiilor ca baza pentru toata firma. Doar admin — altfel un
  // agent ar putea schimba pretul cu care lucreaza toti ceilalti.
  router.post("/calculator/awb/salveaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/awb");
    await scrieAsumptii(ctx.body || {});
    return redirect(ctx.res, "/calculator/awb?salvat=1");
  });
}

module.exports = { register, calculeaza, dinStoc, necesar, citesteAsumptii, IMPLICITE, CAMPURI };
