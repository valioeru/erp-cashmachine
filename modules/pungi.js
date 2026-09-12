"use strict";
// Calculatorul de pungi curier — costul complet, de la granulă la cutia livrată.
//
// De ce există: prețul unei pungi de curierat se năștea într-un Excel ținut
// local, cu șapte foi care se refereau una pe alta. Aici e același model, cu
// aceleași formule, dar asumpțiile stau o singură dată în baza de date — deci
// toți agenții dau același preț, iar când se mișcă cursul sau prețul unei
// granule se schimbă într-un singur loc.
//
// Lanțul de cost are patru etape, fiecare cu unitatea ei naturală:
//   EXTRUDARE  — lei/kg folie   (granulă + electricitate + manoperă)
//   PRINTARE   — lei/m² printat (cerneală + electricitate + manoperă)
//   DEBITARE   — lei/1000 buc   (manoperă + electricitate, corectat cu rebut)
//   AMBALARE   — lei/1000 buc   (bandă de închidere + cutie de carton)
// Peste ele se adaugă costul de schimbare a tipului de folie, amortizat pe
// cantitatea comenzii — de-aia prețul pe bucată SCADE cu cantitatea. Pornirea
// rece a liniei (120 kW × 3 h) e un eveniment rar, nu unul per comandă, deci
// apare doar ca referință, nu în preț.
//
// Convenția de culori e cea din fișierul primit:
//   GALBEN = dată confirmată de firmă, se scrie de mână
//   BEJ    = presupunere neconfirmată, tot se scrie de mână, dar e de corectat
//   GRI    = calculată automat, nu se atinge
// Cele bej sunt intrări, nu formule — fișierul însuși cere să fie corectate,
// deci ar fi fost o greșeală să le blocăm.

const db = require("../lib/db");
const { esc, layout, table, subnavCrm, selectorCalculator } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Datele de intrare. Al cincilea element: "ok" = confirmat (galben),
// "dc" = de confirmat (bej). Ordinea de aici e ordinea de pe pagină.
const ASUMPTII = [
  ["sect", "1. Curs valutar"],
  ["curs", "Curs de schimb", 5.25, "RON / EUR", "ok"],

  ["sect", "2. Materiale extrudare (granule) — prețuri furnizor"],
  ["ldpe_eur", "LDPE", 1.3, "EUR/kg", "ok"],
  ["lldpe_eur", "LLDPE", 1.295, "EUR/kg", "ok"],
  ["hdpe_eur", "HDPE", 1.8, "EUR/kg", "ok"],
  ["mba_eur", "Masterbatch alb", 3.25, "EUR/kg", "ok"],
  ["mbn_eur", "Masterbatch negru", 2, "EUR/kg", "ok"],
  ["mbd_eur", "Masterbatch divers", 0, "EUR/kg", "dc"],
  ["recn_eur", "Reciclat natur", 1, "EUR/kg", "ok"],
  ["reci_eur", "Reciclat închis", 0.72, "EUR/kg", "ok"],

  ["sect", "3. Extruder — specificații tehnice"],
  ["gros_min", "Grosime folie — minim posibil", 20, "microni", "ok"],
  ["gros_max", "Grosime folie — maxim posibil", 100, "microni", "ok"],
  ["gros_impl", "Grosime folie — valoare implicită (referință)", 45, "microni", "ok"],
  ["folie_latime", "Lățime folie (lay-flat)", 1650, "mm", "ok"],
  ["folie_desf", "Lățime folie desfășurată", 3200, "mm", "ok"],
  ["viteza_mica", "Viteză extrudare — pungi ≤ 500 mm", 110, "kg/h", "ok"],
  ["viteza_mare", "Viteză extrudare — pungi mari", 160, "kg/h", "ok"],
  ["putere_pornire", "Putere consumată — pornire rece / încălzire linie", 120, "kW", "ok"],
  ["durata_pornire", "Durată pornire rece / încălzire linie", 3, "ore", "ok"],
  ["putere_operare", "Putere consumată — regim de operare", 80, "kW", "ok"],
  ["pret_energie", "Preț energie electrică", 1, "lei/kWh", "ok"],
  ["durata_schimbare", "Durată schimbare tip folie (linie deja caldă)", 30, "minute", "ok"],
  ["pierdere_material", "Pierdere de material la fiecare schimbare de tip folie", 45, "kg", "dc"],
  ["densitate", "Densitate folie PE (amestec LDPE/LLDPE/reciclat)", 920, "kg/m³", "dc"],

  ["sect", "4. Personal linie extrudare"],
  ["oameni_extr", "Număr oameni la extruder", 1, "persoane", "ok"],
  ["cost_ora_extr", "Cost operare (manoperă) / oră", 56, "RON/oră", "ok"],

  ["sect", "5. Flexo Print — mașina de printare"],
  ["flexo_viteza", "Viteză utilaj", 200, "m/min", "ok"],
  ["flexo_putere", "Putere consumată", 80, "kW", "ok"],
  ["flexo_operatori", "Număr operatori", 1, "persoane", "ok"],
  ["flexo_cost_ora", "Cost operare (manoperă) / oră", 56, "RON/oră", "ok"],
  ["cerneala_eur", "Preț cerneală", 12, "EUR/kg", "ok"],
  ["cerneala_g_m2", "Consum cerneală, estimat (generic, alte comenzi)", 2, "g/m²", "dc"],

  ["sect", "6. Debitare pungi — mașina de debitat"],
  ["clapa", "Clapă pungă (adaos închidere, la desfășurată)", 50, "mm", "ok"],
  ["viteza_deb_mic", "Viteză — pungi ≤ 400 mm înălțime", 120, "buc/min", "ok"],
  ["viteza_deb_mare", "Viteză — pungi > 400 mm înălțime", 90, "buc/min", "dc"],
  ["inaltime_max", "Înălțime maximă pungă (limita mașinii)", 700, "mm", "ok"],
  ["putere_deb", "Putere consumată", 5, "kW", "ok"],
  ["operatori_deb", "Număr operatori", 1, "persoane", "ok"],
  ["cost_ora_deb", "Cost operare (manoperă) / oră", 45, "RON/oră", "ok"],
  ["rebut_mare", "Rebut — comenzi peste 100.000 buc", 0.005, "fracție (0,005 = 0,5%)", "ok"],
  ["rebut_mic", "Rebut — comenzi sub 100.000 buc", 0.015, "fracție (0,015 = 1,5%)", "dc"],

  ["sect", "7. Bandă de închidere autoadezivă"],
  ["banda_latime", "Lățime rolă", 20, "mm", "ok"],
  ["banda_lungime", "Lungime rolă", 2300, "mm", "ok"],
  ["banda_eur", "Preț", 0.18, "EUR/m²", "ok"],

  ["sect", "8. Ambalare — cutii carton"],
  ["cutie_buc_mic", "Buc/cutie — pungi ≤ 400 mm înălțime", 1000, "buc", "ok"],
  ["cutie_buc_mare", "Buc/cutie — pungi > 400 mm înălțime", 500, "buc", "ok"],
  ["pret_cutie", "Preț cutie", 2.6, "lei/buc", "dc"],
];

const CAMPURI = ASUMPTII.filter((x) => x[0] !== "sect");
const IMPLICITE = Object.fromEntries(CAMPURI.map((c) => [c[0], c[2]]));

// Valorile calculate care apar sub câmpurile secțiunii lor, ca în foaia
// "Asumptii" din Excel. Cheia e titlul secțiunii.
const CALCULATE = {
  "2. Materiale extrudare (granule) — prețuri furnizor": [
    ["LDPE", (r) => r.pret.ldpe, "RON/kg"],
    ["LLDPE", (r) => r.pret.lldpe, "RON/kg"],
    ["HDPE", (r) => r.pret.hdpe, "RON/kg"],
    ["Masterbatch alb", (r) => r.pret.mba, "RON/kg"],
    ["Masterbatch negru", (r) => r.pret.mbn, "RON/kg"],
    ["Masterbatch divers", (r) => r.pret.mbd, "RON/kg"],
    ["Reciclat natur", (r) => r.pret.recn, "RON/kg"],
    ["Reciclat închis", (r) => r.pret.reci, "RON/kg"],
  ],
  "5. Flexo Print — mașina de printare": [
    ["Preț cerneală", (r) => r.cernealaRon, "RON/kg"],
    ["Debit utilaj (viteză × 60 × lățime folie)", (r) => r.flexoDebit, "m²/h"],
  ],
  "7. Bandă de închidere autoadezivă": [
    ["Preț bandă", (r) => r.bandaRon, "RON/m²"],
  ],
};

// Compoziția unei rețete, în procente. Trebuie să însumeze 100.
const RETETA_CAMPURI = [
  ["ldpe", "LDPE %", "ldpe"],
  ["lldpe", "LLDPE %", "lldpe"],
  ["hdpe", "HDPE %", "hdpe"],
  ["mb_alb", "Masterbatch alb %", "mba"],
  ["mb_negru", "Masterbatch negru %", "mbn"],
  ["mb_divers", "Masterbatch divers %", "mbd"],
  ["rec_natur", "Reciclat natur %", "recn"],
  ["rec_inchis", "Reciclat închis %", "reci"],
];

const RETETE_IMPLICITE = [
  { nume: "Sameday", ldpe: 12, lldpe: 40, hdpe: 0, mb_alb: 7, mb_negru: 1, mb_divers: 0, rec_natur: 20, rec_inchis: 20 },
];

const FORMATE_IMPLICITE = [
  { nume: "Sameday", latime: 300, inaltime: 400, cerneala: 0.235, print: "Da", cantitate: 200000, grosime: 45, reteta: "Sameday" },
  { nume: "A4", latime: 300, inaltime: 400, cerneala: 0.235, print: "Da", cantitate: 200000, grosime: 45, reteta: "Sameday" },
  { nume: "A3", latime: 500, inaltime: 500, cerneala: 0.45, print: "Da", cantitate: 100000, grosime: 45, reteta: "Sameday" },
  { nume: "Pungă simplă", latime: 500, inaltime: 700, cerneala: 0, print: "Nu", cantitate: 100000, grosime: 45, reteta: "Sameday" },
  { nume: "DPD", latime: 330, inaltime: 410, cerneala: 0.18, print: "Da", cantitate: 100000, grosime: 45, reteta: "Sameday" },
];

// ---- Motorul de calcul ----------------------------------------------------
// Primește asumpțiile, rețetele și formatele; întoarce tot ce se afișează.
// Nu atinge baza de date — ca să poată fi verificat cu creionul pe hârtie.
function calculeaza(a, retete, formate) {
  const n = (k) => {
    const v = Number(a[k]);
    return isFinite(v) ? v : 0;
  };
  const curs = n("curs");

  // Prețurile granulelor în lei.
  const pret = {
    ldpe: n("ldpe_eur") * curs,
    lldpe: n("lldpe_eur") * curs,
    hdpe: n("hdpe_eur") * curs,
    mba: n("mba_eur") * curs,
    mbn: n("mbn_eur") * curs,
    mbd: n("mbd_eur") * curs,
    recn: n("recn_eur") * curs,
    reci: n("reci_eur") * curs,
  };
  const cernealaRon = n("cerneala_eur") * curs;
  const bandaRon = n("banda_eur") * curs;

  // ---- Extrudare: lei / kg folie ----------------------------------------
  // Viteza mică (pungi ≤ 500 mm) e cea folosită în preț; cea mare apare doar
  // ca referință, pentru că la pungile mari electricitatea pe kg scade.
  const extrElec = n("viteza_mica") ? (n("putere_operare") * n("pret_energie")) / n("viteza_mica") : 0;
  const extrManop = n("viteza_mica") ? (n("cost_ora_extr") * n("oameni_extr")) / n("viteza_mica") : 0;
  const extrElecMax = n("viteza_mare") ? (n("putere_operare") * n("pret_energie")) / n("viteza_mare") : 0;
  // Costul de conversie: tot ce se adaugă peste granulă, pe kg de folie.
  const extrConversie = extrElec + extrManop;

  // Evenimente rare / periodice, cu cost fix.
  const pornireRece = n("putere_pornire") * n("durata_pornire") * n("pret_energie");
  const schimbareElec = n("putere_operare") * (n("durata_schimbare") / 60) * n("pret_energie");

  // ---- Printare: lei / m² folie printată --------------------------------
  const flexoDebit = (n("flexo_viteza") * 60 * n("folie_latime")) / 1000;
  const prCerneala = (n("cerneala_g_m2") / 1000) * cernealaRon;
  const prElec = flexoDebit ? (n("flexo_putere") * n("pret_energie")) / flexoDebit : 0;
  const prManop = flexoDebit ? (n("flexo_cost_ora") * n("flexo_operatori")) / flexoDebit : 0;
  const prTotal = prCerneala + prElec + prManop;
  // Electricitatea + manopera de printare, pe m² — singura parte care se
  // aplică pe arie; cerneala se ia din consumul real al formatului.
  const prFixM2 = prElec + prManop;

  // ---- Debitare: lei / 1000 buc ----------------------------------------
  const debitare = (viteza) => {
    if (!viteza) return { manop: 0, elec: 0, total: 0 };
    const manop = ((n("cost_ora_deb") * n("operatori_deb")) / 60 / viteza) * 1000;
    const elec = ((n("putere_deb") * n("pret_energie")) / 60 / viteza) * 1000;
    return { manop, elec, total: manop + elec };
  };
  const debMic = debitare(n("viteza_deb_mic"));
  const debMare = debitare(n("viteza_deb_mare"));

  // ---- Rețetele de folie ------------------------------------------------
  // Prețul mediu al amestecului = media ponderată a granulelor. Se împarte la
  // suma procentelor, nu la 100 — așa iese corect și dacă rețeta nu însumează
  // exact 100 (caz în care e semnalat separat, ca greșeală de introdus).
  const retList = (retete || []).map((rt) => {
    let suma = 0;
    let val = 0;
    for (const [cheie, , pk] of RETETA_CAMPURI) {
      const p = Number(rt[cheie]) || 0;
      suma += p;
      val += p * (pret[pk] || 0);
    }
    return {
      nume: String(rt.nume || "").trim(),
      procente: Object.fromEntries(RETETA_CAMPURI.map(([c]) => [c, Number(rt[c]) || 0])),
      suma,
      pretMediu: suma ? val / suma : 0,
      ok: Math.abs(suma - 100) < 0.0001,
    };
  });
  const hartaRet = new Map();
  for (const rt of retList) if (rt.nume) hartaRet.set(rt.nume.toLowerCase(), rt);

  // ---- Un format: de la dimensiuni la preț ------------------------------
  const unFormat = (f) => {
    const lat = Number(f.latime) || 0;
    const inalt = Number(f.inaltime) || 0;
    const gros = Number(f.grosime) || 0;
    const cant = Number(f.cantitate) || 0;
    const cerneala = Number(f.cerneala) || 0;
    const cuPrint = String(f.print || "Da").toLowerCase() !== "nu";
    const numeRet = String(f.reteta || "").trim();
    const rt = hartaRet.get(numeRet.toLowerCase()) || null;
    const pretGranula = rt ? rt.pretMediu : 0;

    // Aria unei fețe, pentru printare — fără clapă (nu se tipărește).
    const arie = (lat / 1000) * (inalt / 1000);
    // Greutatea foliei: lungimea desfășurată e 2 × înălțime + clapa de
    // închidere. Grosimea e în microni, densitatea în kg/m³ → grame.
    const greutate = (lat / 1000) * ((2 * inalt + n("clapa")) / 1000) * gros * (n("densitate") / 1000);
    const bandaLung = lat / 1000;

    const mica = inalt <= 400;
    const rebut = cant >= 100000 ? n("rebut_mare") : n("rebut_mic");

    const cExtrudare = greutate * (pretGranula + extrConversie);
    const cPrintare = cuPrint ? ((cerneala / 1000) * cernealaRon + prFixM2 * arie) * 1000 : 0;
    const debBaza = mica ? debMic.total : debMare.total;
    const cDebitare = rebut < 1 ? debBaza / (1 - rebut) : 0;
    const cBanda = bandaLung * (n("banda_latime") / 1000) * bandaRon * 1000;
    const bucCutie = mica ? n("cutie_buc_mic") : n("cutie_buc_mare");
    const cCutie = bucCutie ? (n("pret_cutie") / bucCutie) * 1000 : 0;
    // Schimbarea tipului de folie: o dată per comandă, amortizată pe cantitate.
    const schimbareTotal = schimbareElec + n("pierdere_material") * pretGranula;
    const cSchimbare = cant ? schimbareTotal / (cant / 1000) : 0;

    const total1000 = cExtrudare + cPrintare + cDebitare + cBanda + cCutie + cSchimbare;

    // Necesarul de materie primă pentru cantitatea cerută.
    const kgFolie = (greutate / 1000) * cant;
    const kg = {};
    for (const [cheie] of RETETA_CAMPURI) {
      kg[cheie] = rt ? kgFolie * ((rt.procente[cheie] || 0) / 100) : 0;
    }
    const kgCerneala = cuPrint ? (cerneala / 1000) * cant : 0;
    const m2Banda = bandaLung * (n("banda_latime") / 1000) * cant;
    const cutii = bucCutie ? cant / bucCutie : 0;

    // Avertismente: limitele mașinii, declarate în asumpții.
    const alerte = [];
    if (gros && n("gros_min") && gros < n("gros_min")) alerte.push("grosime sub minimul extruderului");
    if (gros && n("gros_max") && gros > n("gros_max")) alerte.push("grosime peste maximul extruderului");
    if (inalt && n("inaltime_max") && inalt > n("inaltime_max")) alerte.push("înălțime peste limita mașinii de debitat");
    if (lat && n("folie_latime") && lat > n("folie_latime")) alerte.push("lățime peste lățimea foliei");
    if (numeRet && !rt) alerte.push("rețeta „" + numeRet + "” nu există");
    if (!numeRet) alerte.push("fără rețetă aleasă");
    if (rt && !rt.ok) alerte.push("rețeta nu însumează 100%");

    return {
      nume: String(f.nume || "").trim(),
      latime: lat, inaltime: inalt, grosime: gros, cantitate: cant,
      cerneala, cuPrint, reteta: numeRet, pretGranula, rebut, mica,
      arie, greutate, bandaLung, bucCutie,
      cExtrudare, cPrintare, cDebitare, cBanda, cCutie, cSchimbare,
      schimbareTotal, total1000, totalBuc: total1000 / 1000,
      kgFolie, kg, kgCerneala, m2Banda, cutii, alerte,
    };
  };

  const forList = (formate || []).map(unFormat);

  // Totalul necesarului, peste toate formatele — util când se lansează în
  // producție mai multe comenzi deodată.
  const totalNec = { cantitate: 0, kgFolie: 0, kg: {}, kgCerneala: 0, m2Banda: 0, cutii: 0 };
  for (const [cheie] of RETETA_CAMPURI) totalNec.kg[cheie] = 0;
  for (const x of forList) {
    totalNec.cantitate += x.cantitate;
    totalNec.kgFolie += x.kgFolie;
    totalNec.kgCerneala += x.kgCerneala;
    totalNec.m2Banda += x.m2Banda;
    totalNec.cutii += x.cutii;
    for (const [cheie] of RETETA_CAMPURI) totalNec.kg[cheie] += x.kg[cheie];
  }

  return {
    pret, cernealaRon, bandaRon,
    extrElec, extrManop, extrElecMax, extrConversie,
    pornireRece, schimbareElec,
    flexoDebit, prCerneala, prElec, prManop, prTotal, prFixM2,
    debMic, debMare,
    retete: retList, hartaRet, formate: forList, totalNec,
    unFormat,
  };
}

// ---- Datele din baza de date ---------------------------------------------
// Trei rânduri JSON în setari_app: asumpțiile (46 de numere care se citesc
// mereu împreună), rețetele și formatele. Un tabel propriu n-ar aduce nimic —
// nu se caută niciodată o singură asumpție.
const CHEIE_A = "pungi_asumptii";
const CHEIE_R = "pungi_retete";
const CHEIE_F = "pungi_formate";

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

async function citesteRetete() {
  const salvate = await citesteJson(CHEIE_R);
  if (!Array.isArray(salvate)) return RETETE_IMPLICITE.map((x) => Object.assign({}, x));
  return salvate.map((rt) => {
    const o = { nume: String(rt && rt.nume ? rt.nume : "").slice(0, 80) };
    for (const [cheie] of RETETA_CAMPURI) {
      const v = Number(rt ? rt[cheie] : 0);
      o[cheie] = isFinite(v) ? v : 0;
    }
    return o;
  });
}

async function citesteFormate() {
  const salvate = await citesteJson(CHEIE_F);
  if (!Array.isArray(salvate)) return FORMATE_IMPLICITE.map((x) => Object.assign({}, x));
  return salvate.map((f) => ({
    nume: String(f && f.nume ? f.nume : "").slice(0, 80),
    latime: Number(f && f.latime) || 0,
    inaltime: Number(f && f.inaltime) || 0,
    cerneala: Number(f && f.cerneala) || 0,
    print: String(f && f.print).toLowerCase() === "nu" ? "Nu" : "Da",
    cantitate: Number(f && f.cantitate) || 0,
    grosime: Number(f && f.grosime) || 0,
    reteta: String(f && f.reteta ? f.reteta : "").slice(0, 80),
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
  router.get("/calculator/pungi", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const baza = await citesteAsumptii();
    const retete = await citesteRetete();
    const formate = await citesteFormate();

    // Orice asumpție poate fi suprascrisă din adresa paginii, fără să se
    // salveze — așa se poate trimite un link cu un scenariu („ce iese dacă
    // urcă cursul la 5,4”) fără să se schimbe cifrele pentru toată lumea.
    const a = Object.assign({}, baza);
    const modificat = [];
    for (const c of CAMPURI) {
      const q = ctx.query && ctx.query[c[0]];
      if (q !== undefined && q !== "") {
        const v = numar(q);
        if (isFinite(v) && v !== baza[c[0]]) { a[c[0]] = v; modificat.push(c[1]); }
      }
    }

    const r = calculeaza(a, retete, formate);

    // ---- Calcul rapid: o pungă cerută acum, fără să se salveze nimic ------
    const q = ctx.query || {};
    const cerut = {
      nume: String(q.q_nume || "Cerere nouă").slice(0, 80),
      latime: numar(q.q_latime),
      inaltime: numar(q.q_inaltime),
      grosime: q.q_grosime === undefined || q.q_grosime === "" ? a.gros_impl : numar(q.q_grosime),
      cerneala: numar(q.q_cerneala),
      print: String(q.q_print || "Da").toLowerCase() === "nu" ? "Nu" : "Da",
      cantitate: numar(q.q_cantitate),
      reteta: String(q.q_reteta || (retete[0] ? retete[0].nume : "")).slice(0, 80),
    };
    const areCerere = cerut.latime > 0 && cerut.inaltime > 0 && cerut.cantitate > 0;
    const rapid = areCerere ? r.unFormat(cerut) : null;
    const marjaRapid = q.q_marja === undefined || q.q_marja === "" ? 25 : numar(q.q_marja);

    const optReteta = (ales) =>
      retete
        .map((rt) => `<option value="${esc(rt.nume)}"${String(rt.nume) === String(ales) ? " selected" : ""}>${esc(rt.nume)}</option>`)
        .join("");

    const rapidHtml = `
      <form method="get" action="/calculator/pungi" class="form" style="max-width:1100px;margin-bottom:6px">
        <div class="pungi-rapid">
          <label class="field"><span>Client / denumire</span><input type="text" name="q_nume" value="${esc(cerut.nume)}"></label>
          <label class="field"><span>Lățime <span class="mic">mm</span></span><input type="number" step="any" name="q_latime" value="${esc(cerut.latime ? String(cerut.latime) : "")}"></label>
          <label class="field"><span>Înălțime <span class="mic">mm</span></span><input type="number" step="any" name="q_inaltime" value="${esc(cerut.inaltime ? String(cerut.inaltime) : "")}"></label>
          <label class="field"><span>Grosime <span class="mic">microni</span></span><input type="number" step="any" name="q_grosime" value="${esc(String(cerut.grosime))}"></label>
          <label class="field"><span>Cantitate <span class="mic">buc</span></span><input type="number" step="any" name="q_cantitate" value="${esc(cerut.cantitate ? String(cerut.cantitate) : "")}"></label>
          <label class="field"><span>Cu print?</span><select name="q_print"><option value="Da"${cerut.print === "Da" ? " selected" : ""}>Da</option><option value="Nu"${cerut.print === "Nu" ? " selected" : ""}>Nu</option></select></label>
          <label class="field"><span>Cerneală <span class="mic">g/pungă</span></span><input type="number" step="any" name="q_cerneala" value="${esc(String(cerut.cerneala))}"></label>
          <label class="field"><span>Rețetă folie</span><select name="q_reteta">${optReteta(cerut.reteta)}</select></label>
          <label class="field"><span>Marjă <span class="mic">% adaos</span></span><input type="number" step="any" name="q_marja" value="${esc(String(marjaRapid))}"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Calculează</button>
          <a class="btn secondary" href="/calculator/pungi">Golește</a></div>
      </form>`;

    const rapidRez = !rapid
      ? ""
      : `<div class="pungi-rezultat">
          <div class="pungi-mare">
            <span class="mic">Cost / pungă</span>
            <strong>${nr(rapid.totalBuc, 4)} lei</strong>
            <span class="mic">${nr(rapid.total1000)} lei / 1000 buc</span>
          </div>
          <div class="pungi-mare">
            <span class="mic">Preț la ${nr(marjaRapid, 0)}% adaos</span>
            <strong style="color:var(--success)">${nr(rapid.totalBuc * (1 + marjaRapid / 100), 4)} lei</strong>
            <span class="mic">${nr(rapid.total1000 * (1 + marjaRapid / 100))} lei / 1000 buc</span>
          </div>
          <div class="pungi-mare">
            <span class="mic">Valoare comandă (cost)</span>
            <strong>${nr((rapid.total1000 / 1000) * rapid.cantitate)} lei</strong>
            <span class="mic">${nr(rapid.kgFolie, 1)} kg folie, ${nr(rapid.cutii, 0)} cutii</span>
          </div>
          <div class="awb-calc" style="flex:1 1 100%">
            ${[
              ["Greutate folie / pungă", rapid.greutate, "g"],
              ["Preț granulă (rețeta aleasă)", rapid.pretGranula, "RON/kg"],
              ["Extrudare / 1000", rapid.cExtrudare, "lei"],
              ["Printare / 1000", rapid.cPrintare, "lei"],
              ["Debitare (cu rebut) / 1000", rapid.cDebitare, "lei"],
              ["Bandă / 1000", rapid.cBanda, "lei"],
              ["Cutie / 1000", rapid.cCutie, "lei"],
              ["Schimbare tip folie / 1000", rapid.cSchimbare, "lei"],
              ["Rebut aplicat", rapid.rebut * 100, "%"],
              ["Arie printată / pungă", rapid.arie, "m²"],
            ]
              .map(
                ([et, v, um]) => `<div class="awb-calc-rand"><span class="awb-calc-et">${esc(et)}</span>
                  <span class="awb-calc-val">${esc(taieZerouri(v))} <span class="mic">${esc(um)}</span></span></div>`
              )
              .join("")}
          </div>
          ${rapid.alerte.length ? `<p class="mic" style="flex:1 1 100%;color:var(--danger,#b91c1c);margin:0">De verificat: ${esc(rapid.alerte.join("; "))}</p>` : ""}
        </div>`;

    // ---- Tabelul de prețuri pe format -------------------------------------
    const capPret = ["Format", "Lățime (mm)", "Înălțime (mm)", "Grosime (microni)", "Print",
      "Cantitate (buc)", "Rețetă folie", "Greutate folie (g/pungă)",
      "TOTAL / 1000 pungi (lei)", "TOTAL / pungă (lei)"];
    const randPret = r.formate.map((x) => [
      `<strong>${esc(x.nume)}</strong>${x.alerte.length ? ` <span class="badge gri" title="${esc(x.alerte.join("; "))}">de verificat</span>` : ""}`,
      nr(x.latime, 0), nr(x.inaltime, 0), nr(x.grosime, 0),
      x.cuPrint ? "Da" : "Nu",
      nr(x.cantitate, 0), esc(x.reteta || "—"),
      nr(x.greutate, 3),
      `<strong>${nr(x.total1000)}</strong>`,
      `<strong>${nr(x.totalBuc, 4)}</strong>`,
    ]);

    // ---- Detalierea costului pe format ------------------------------------
    const capDet = ["Format", "Extrudare (lei/1000)", "Printare (lei/1000)", "Debitare cu rebut (lei/1000)",
      "Bandă (lei/1000)", "Cutie (lei/1000)", "Schimbare tip folie (lei/1000)",
      "TOTAL (lei/1000)", "Preț granulă (RON/kg)", "Rebut aplicat (%)"];
    const randDet = r.formate.map((x) => [
      `<strong>${esc(x.nume)}</strong>`,
      nr(x.cExtrudare), nr(x.cPrintare), nr(x.cDebitare),
      nr(x.cBanda), nr(x.cCutie), nr(x.cSchimbare),
      `<strong>${nr(x.total1000)}</strong>`,
      nr(x.pretGranula, 4), nr(x.rebut * 100, 2),
    ]);

    // ---- Necesarul de materie primă ---------------------------------------
    const capNec = ["Format", "Cantitate (buc)", "Kg folie total",
      "LDPE (kg)", "LLDPE (kg)", "HDPE (kg)", "MB alb (kg)", "MB negru (kg)", "MB divers (kg)",
      "Reciclat natur (kg)", "Reciclat închis (kg)", "Cerneală (kg)", "Bandă (m²)", "Cutii (buc)"];
    const randNec = r.formate.map((x) => [
      `<strong>${esc(x.nume)}</strong>`,
      nr(x.cantitate, 0), nr(x.kgFolie, 2),
      nr(x.kg.ldpe, 2), nr(x.kg.lldpe, 2), nr(x.kg.hdpe, 2),
      nr(x.kg.mb_alb, 2), nr(x.kg.mb_negru, 2), nr(x.kg.mb_divers, 2),
      nr(x.kg.rec_natur, 2), nr(x.kg.rec_inchis, 2),
      nr(x.kgCerneala, 2), nr(x.m2Banda, 0),
      nr(Math.ceil(x.cutii), 0),
    ]);
    const tn = r.totalNec;
    const totalNecRand = [
      "<strong>TOTAL</strong>",
      `<strong>${nr(tn.cantitate, 0)}</strong>`, `<strong>${nr(tn.kgFolie, 2)}</strong>`,
      `<strong>${nr(tn.kg.ldpe, 2)}</strong>`, `<strong>${nr(tn.kg.lldpe, 2)}</strong>`, `<strong>${nr(tn.kg.hdpe, 2)}</strong>`,
      `<strong>${nr(tn.kg.mb_alb, 2)}</strong>`, `<strong>${nr(tn.kg.mb_negru, 2)}</strong>`, `<strong>${nr(tn.kg.mb_divers, 2)}</strong>`,
      `<strong>${nr(tn.kg.rec_natur, 2)}</strong>`, `<strong>${nr(tn.kg.rec_inchis, 2)}</strong>`,
      `<strong>${nr(tn.kgCerneala, 2)}</strong>`, `<strong>${nr(tn.m2Banda, 0)}</strong>`,
      `<strong>${nr(r.formate.reduce((s, x) => s + Math.ceil(x.cutii), 0), 0)}</strong>`,
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

    const etapeHtml =
      blocEtape("Extrudare — lei / kg folie", [
        ["Electricitate (regim de operare)", r.extrElec, "lei/kg", "kW operare × preț/kWh ÷ viteză (kg/h)"],
        ["Manoperă", r.extrManop, "lei/kg", "cost/oră × nr. oameni ÷ viteză (kg/h)"],
        ["Cost de conversie (fără granulă)", r.extrConversie, "lei/kg", "se adaugă peste prețul granulei rețetei"],
        ["Electricitate la viteză maximă (pungi mari)", r.extrElecMax, "lei/kg", "referință: la " + nr(a.viteza_mare, 0) + " kg/h"],
        ["Pornire RECE a liniei (eveniment rar)", r.pornireRece, "lei", "putere pornire × " + nr(a.durata_pornire, 0) + " h × preț/kWh — NU e în preț"],
        ["Schimbare tip folie — doar electricitatea", r.schimbareElec, "lei", "linie caldă, " + nr(a.durata_schimbare, 0) + " min"],
      ], "Materialul nu apare aici: vine din rețeta fiecărui format, pentru că fiecare client are alt amestec.") +
      blocEtape("Printare — lei / m² folie printată", [
        ["Debit utilaj", r.flexoDebit, "m²/h", "viteză × 60 × lățime folie"],
        ["Cerneală (consum generic presupus)", r.prCerneala, "lei/m²", nr(a.cerneala_g_m2, 2) + " g/m² × preț cerneală"],
        ["Electricitate", r.prElec, "lei/m²"],
        ["Manoperă", r.prManop, "lei/m²"],
        ["TOTAL printare (consum generic)", r.prTotal, "lei/m²", "la formate se folosește consumul REAL de cerneală, nu cel generic"],
      ], "") +
      blocEtape("Debitare — lei / 1000 pungi", [
        ["Manoperă — pungi ≤ 400 mm", r.debMic.manop, "lei/1000"],
        ["Electricitate — pungi ≤ 400 mm", r.debMic.elec, "lei/1000"],
        ["TOTAL — pungi ≤ 400 mm (fără rebut)", r.debMic.total, "lei/1000"],
        ["Manoperă — pungi > 400 mm", r.debMare.manop, "lei/1000"],
        ["Electricitate — pungi > 400 mm", r.debMare.elec, "lei/1000"],
        ["TOTAL — pungi > 400 mm (fără rebut)", r.debMare.total, "lei/1000"],
      ], "Rebutul se aplică peste, în funcție de cantitatea comenzii: ≥ 100.000 buc → " +
         nr(a.rebut_mare * 100, 2) + "%, sub → " + nr(a.rebut_mic * 100, 2) + "%.");

    // ---- Rețetele de folie (tabel editabil) --------------------------------
    // Un rând per client/produs. Rândul gol de la final e pentru adăugare —
    // se ignoră dacă rămâne fără nume.
    const randuriRet = r.retete.concat(eAdmin ? [{ nume: "", procente: Object.fromEntries(RETETA_CAMPURI.map(([c]) => [c, 0])), suma: 0, pretMediu: 0, ok: false }] : []);
    const reteteHtml = eAdmin
      ? `<form method="post" action="/calculator/pungi/retete">
          <div class="tabel-scroll"><table class="table">
            <thead><tr>
              <th>Rețetă (client / produs)</th>
              ${RETETA_CAMPURI.map(([, et]) => `<th>${esc(et)}</th>`).join("")}
              <th>Sumă %</th><th>Preț mediu (RON/kg)</th><th>Șterge</th>
            </tr></thead>
            <tbody>${randuriRet
              .map((rt, i) => `<tr>
                <td><input class="pungi-in pungi-text" type="text" name="r${i}_nume" value="${esc(rt.nume)}" placeholder="nume client"></td>
                ${RETETA_CAMPURI.map(([c]) => `<td><input class="pungi-in" type="number" step="any" name="r${i}_${c}" value="${esc(String(rt.procente[c]))}"></td>`).join("")}
                <td>${rt.nume ? `<strong${rt.ok ? "" : ' style="color:var(--danger,#b91c1c)"'}>${nr(rt.suma, 2)}</strong>` : "—"}</td>
                <td>${rt.nume ? `<strong>${nr(rt.pretMediu, 4)}</strong>` : "—"}</td>
                <td>${rt.nume ? `<input type="checkbox" name="del${i}" value="1">` : ""}</td>
              </tr>`)
              .join("")}</tbody>
          </table></div>
          <div class="form-actions"><button class="btn" type="submit">Salvează rețetele</button></div>
        </form>`
      : `<div class="tabel-scroll">${table(
          ["Rețetă (client / produs)"].concat(RETETA_CAMPURI.map(([, et]) => et)).concat(["Sumă %", "Preț mediu (RON/kg)"]),
          r.retete.map((rt) => [`<strong>${esc(rt.nume)}</strong>`]
            .concat(RETETA_CAMPURI.map(([c]) => nr(rt.procente[c], 2)))
            .concat([rt.ok ? nr(rt.suma, 2) : `<span style="color:var(--danger,#b91c1c)">${nr(rt.suma, 2)}</span>`, `<strong>${nr(rt.pretMediu, 4)}</strong>`]))
        )}</div>`;

    // ---- Formatele (tabel editabil) ----------------------------------------
    const randuriFor = formate.concat(eAdmin ? [{ nume: "", latime: "", inaltime: "", cerneala: 0, print: "Da", cantitate: "", grosime: a.gros_impl, reteta: retete[0] ? retete[0].nume : "" }] : []);
    const formateHtml = eAdmin
      ? `<form method="post" action="/calculator/pungi/formate">
          <div class="tabel-scroll"><table class="table">
            <thead><tr>
              <th>Cod produs / client</th><th>Lățime (mm)</th><th>Înălțime (mm)</th>
              <th>Grosime (microni)</th><th>Cerneală (g/pungă)</th><th>Cu print?</th>
              <th>Cantitate (buc)</th><th>Rețetă folie</th><th>Șterge</th>
            </tr></thead>
            <tbody>${randuriFor
              .map((f, i) => `<tr>
                <td><input class="pungi-in pungi-text" type="text" name="f${i}_nume" value="${esc(String(f.nume))}" placeholder="cod / client"></td>
                <td><input class="pungi-in" type="number" step="any" name="f${i}_latime" value="${esc(String(f.latime))}"></td>
                <td><input class="pungi-in" type="number" step="any" name="f${i}_inaltime" value="${esc(String(f.inaltime))}"></td>
                <td><input class="pungi-in" type="number" step="any" name="f${i}_grosime" value="${esc(String(f.grosime))}"></td>
                <td><input class="pungi-in" type="number" step="any" name="f${i}_cerneala" value="${esc(String(f.cerneala))}"></td>
                <td><select class="pungi-in" name="f${i}_print"><option value="Da"${f.print !== "Nu" ? " selected" : ""}>Da</option><option value="Nu"${f.print === "Nu" ? " selected" : ""}>Nu</option></select></td>
                <td><input class="pungi-in" type="number" step="any" name="f${i}_cantitate" value="${esc(String(f.cantitate))}"></td>
                <td><select class="pungi-in" name="f${i}_reteta"><option value=""></option>${optReteta(f.reteta)}</select></td>
                <td>${f.nume ? `<input type="checkbox" name="delf${i}" value="1">` : ""}</td>
              </tr>`)
              .join("")}</tbody>
          </table></div>
          <div class="form-actions"><button class="btn" type="submit">Salvează formatele</button></div>
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
      ? `<form method="post" action="/calculator/pungi/asumptii">${campuriHtml}
          <div class="form-actions"><button class="btn" type="submit">Salvează asumpțiile</button></div>
        </form>`
      : campuriHtml;

    const nereguli = r.retete.filter((rt) => rt.nume && !rt.ok);

    const body = `
      ${subnavCrm("/calculator", ctx.user)}
      ${selectorCalculator("/calculator/pungi")}
      <p class="mic" style="margin:0 0 12px;max-width:940px">
        Costul complet al unei pungi de curierat, de la granulă la cutia livrată: extrudare (lei/kg),
        printare (lei/m²), debitare (lei/1000) și ambalare, plus costul de schimbare a tipului de folie
        amortizat pe cantitatea comenzii. De-aia <b>prețul pe bucată scade cu cantitatea</b>.
        Toate cifrele vin din <a href="#asumptii">asumpțiile de jos</a>.
      </p>

      ${ctx.query && ctx.query.salvat ? `<div class="flash">Salvat.</div>` : ""}
      ${modificat.length
        ? `<div class="flash">Te uiți la un <b>scenariu</b>, nu la cifrele salvate: ${esc(modificat.join(", "))}.
           <a href="/calculator/pungi">Înapoi la cifrele firmei</a></div>`
        : ""}
      ${nereguli.length
        ? `<div class="flash warn">Rețete care nu însumează 100%: ${esc(nereguli.map((x) => x.nume + " (" + nr(x.suma, 2) + "%)").join(", "))}.
           Prețul mediu se calculează oricum, ca medie ponderată, dar suma ar trebui să fie 100.</div>`
        : ""}

      <h2 style="margin-top:10px">Calcul rapid pentru o cerere</h2>
      <p class="mic" style="margin:0 0 8px;max-width:900px">Dimensiunile unei cereri primite acum, fără să se salveze nimic.
        Adresa paginii ține tot calculul, deci linkul se poate trimite mai departe.</p>
      ${rapidHtml}
      ${rapidRez}

      <h2 style="margin-top:22px">Prețuri pe format</h2>
      <p class="mic" style="margin:0 0 8px">Formatele salvate ale firmei. Totalul include costul de schimbare a tipului de folie, amortizat pe cantitate.</p>
      <div class="tabel-scroll">${table(capPret, randPret)}</div>

      <h3 class="awb-sect">Din ce se compune totalul</h3>
      <div class="tabel-scroll">${table(capDet, randDet)}</div>

      <h2 style="margin-top:22px">Necesar materie primă</h2>
      <p class="mic" style="margin:0 0 8px">Pentru cantitățile din tabelul de mai sus. Cutiile sunt rotunjite în sus.</p>
      <div class="tabel-lat">${table(capNec, randNec, { total: totalNecRand })}</div>

      <h2 style="margin-top:22px">Costul pe etape</h2>
      <p class="mic" style="margin:0 0 8px">Cifrele intermediare, în unitatea naturală a fiecărei etape — de aici se construiește prețul pe format.</p>
      ${etapeHtml}

      <h2 style="margin-top:22px">Rețete de folie</h2>
      <p class="mic" style="margin:0 0 8px">O rețetă per client sau produs. Prețul mediu al amestecului se calculează singur din prețurile granulelor.
        Mai multe formate pot folosi aceeași rețetă, fără să fie duplicată.</p>
      ${reteteHtml}

      ${eAdmin ? `<h2 style="margin-top:22px">Formate</h2>
        <p class="mic" style="margin:0 0 8px">Dimensiunile și cantitatea fiecărui format. Rândul gol de la final adaugă un format nou; bifa de pe un rând existent îl șterge la salvare.</p>
        ${formateHtml}` : ""}

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
        <p><b>Greutatea foliei.</b> Punga e o folie pliată: lungimea desfășurată e
        <b>2 × înălțime + ${nr(a.clapa, 0)} mm</b> de clapă de închidere. Greutatea = lățime × lungime desfășurată ×
        grosime × densitate (${nr(a.densitate, 0)} kg/m³). Aria pentru printare e doar o față, fără clapă.</p>

        <p><b>Granula.</b> Fiecare client are rețeta lui; prețul amestecului e media ponderată a prețurilor granulelor,
        la cursul de ${nr(a.curs, 2)} lei/EUR. Se presupune 1 kg granulă → 1 kg folie (pierdere de topire neglijabilă).</p>

        <p><b>De ce prețul scade cu cantitatea.</b> O schimbare de tip folie costă
        ${nr(r.schimbareElec)} lei de electricitate plus ${nr(a.pierdere_material, 0)} kg de material pierdut. La o rețetă de
        ${nr(r.retete[0] ? r.retete[0].pretMediu : 0, 2)} lei/kg, asta face ~${nr(r.schimbareElec + a.pierdere_material * (r.retete[0] ? r.retete[0].pretMediu : 0))} lei
        <b>fix, o dată per comandă</b>. Împărțit la 100.000 buc e altceva decât împărțit la 10.000.
        Se presupune <b>o singură schimbare per comandă</b> — dacă în realitate sunt mai multe, costul e subestimat.</p>

        <p><b>Pornirea rece</b> a liniei (${nr(a.putere_pornire, 0)} kW × ${nr(a.durata_pornire, 0)} h = ${nr(r.pornireRece)} lei)
        <b>nu</b> e în preț: e un start de linie, nu un eveniment per comandă. Apare doar ca referință la „Costul pe etape”.</p>

        <p><b>Rebutul</b> se alege automat după cantitate: ≥ 100.000 buc → ${nr(a.rebut_mare * 100, 2)}%, sub → ${nr(a.rebut_mic * 100, 2)}%.
        Se aplică doar peste costul de debitare, ca în fișierul original — nu peste tot costul.</p>

        <p><b>Viteza de extrudare</b> folosită în preț e cea mică (${nr(a.viteza_mica, 0)} kg/h, pungi ≤ 500 mm).
        La pungile mari mașina merge la ${nr(a.viteza_mare, 0)} kg/h și electricitatea pe kg scade — deocamdată asta apare
        doar ca referință, nu se aplică automat pe format.</p>

        <p><b>Ce e de confirmat.</b> Valorile marcate bej sunt presupuneri preluate din fișier:
        densitatea foliei, pierderea de ${nr(a.pierdere_material, 0)} kg la schimbare, consumul generic de cerneală,
        viteza de debitare la pungi mari, rebutul sub 100.000 buc și prețul cutiei. Se pot corecta direct — de-aia n-au fost blocate.</p>

        <p><b>Marja</b> din calculul rapid e adaos peste cost: preț = cost × (1 + marjă). Nu e marjă din prețul de vânzare.</p>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Calculator pungi curier", active: "/crm", body }));
  });

  // ---- Salvările. Toate doar pentru admin: sunt cifrele cu care lucrează
  // toată firma, nu preferințele unui agent. -------------------------------
  router.post("/calculator/pungi/asumptii", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/pungi");
    await scrieAsumptii(ctx.body || {});
    return redirect(ctx.res, "/calculator/pungi?salvat=1#asumptii");
  });

  router.post("/calculator/pungi/retete", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/pungi");
    const b = ctx.body || {};
    const out = [];
    for (let i = 0; i < 200; i++) {
      if (b["r" + i + "_nume"] === undefined) continue;
      if (b["del" + i]) continue;
      const nume = String(b["r" + i + "_nume"] || "").trim().slice(0, 80);
      if (!nume) continue;
      const rt = { nume };
      for (const [cheie] of RETETA_CAMPURI) rt[cheie] = numar(b["r" + i + "_" + cheie]);
      out.push(rt);
    }
    await scrieJson(CHEIE_R, out);
    return redirect(ctx.res, "/calculator/pungi?salvat=1");
  });

  router.post("/calculator/pungi/formate", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator/pungi");
    const b = ctx.body || {};
    const out = [];
    for (let i = 0; i < 200; i++) {
      if (b["f" + i + "_nume"] === undefined) continue;
      if (b["delf" + i]) continue;
      const nume = String(b["f" + i + "_nume"] || "").trim().slice(0, 80);
      if (!nume) continue;
      out.push({
        nume,
        latime: numar(b["f" + i + "_latime"]),
        inaltime: numar(b["f" + i + "_inaltime"]),
        cerneala: numar(b["f" + i + "_cerneala"]),
        print: String(b["f" + i + "_print"] || "Da").toLowerCase() === "nu" ? "Nu" : "Da",
        cantitate: numar(b["f" + i + "_cantitate"]),
        grosime: numar(b["f" + i + "_grosime"]),
        reteta: String(b["f" + i + "_reteta"] || "").trim().slice(0, 80),
      });
    }
    await scrieJson(CHEIE_F, out);
    return redirect(ctx.res, "/calculator/pungi?salvat=1");
  });
}

module.exports = {
  register, calculeaza, citesteAsumptii, citesteRetete, citesteFormate,
  ASUMPTII, CAMPURI, IMPLICITE, RETETA_CAMPURI, RETETE_IMPLICITE, FORMATE_IMPLICITE,
};
