"use strict";
// Balanța „la zi, cu conturile închise" — o ESTIMARE, nu contabilitate.
//
// Balanța pe care o scoate ERP-ul e corectă, dar e o balanță de mijloc de
// lună: clasele 6 și 7 stau deschise, TVA-ul stă nedecontat, iar salariile
// lunii în curs nu există încă fiindcă nu le-a calculat nimeni. Dintr-o
// asemenea balanță nu se citește rezultatul — ceea ce era toată întrebarea.
//
// Ce face fișierul ăsta, peste balanța reală:
//   1. ESTIMEAZĂ ce lipsește din luna în curs, repetând notele lunii trecute
//      care nu vin din documente (salarii, dobânzi, amortizări, chirii).
//   2. ÎNCHIDE TVA: 4427 contra 4426, diferența în 4423 sau 4424.
//   3. ÎNCHIDE clasele 6 și 7 în 121, deci rezultatul se vede direct.
//
// TREI REGULI pe care le respectă, și de ce:
//
// • NU SCRIE NIMIC ÎN REGISTRU. Tot ce face e peste rândurile deja citite,
//   la afișare. O estimare scrisă în `inregistrari_contabile` ar deveni în
//   două săptămâni „ce zice ERP-ul", iar luna viitoare contabila ar închide
//   a doua oară peste ea. Registrul rămâne ce s-a întâmplat; estimarea stă
//   în raport.
//
// • SE REPETĂ NOTE ÎNTREGI, nu conturi. Dacă aș lua „contul 641 a avut luna
//   trecută 50.000" și l-aș adăuga singur, balanța n-ar mai închide — îi
//   lipsește contrapartida. Notele lunii trecute sunt echilibrate prin
//   construcție, deci repetate întregi lasă debitul egal cu creditul. Asta
//   și verifică testul.
//
// • SE REPETĂ DOAR CE NU VINE DIN DOCUMENTE. Facturile, încasările și
//   plățile lunii curente sunt deja în ERP, pe măsură ce se întâmplă — dacă
//   le-aș mai estima o dată, aș număra vânzarea de două ori. Rămân exact
//   lucrurile pe care le scrie contabila o dată pe lună și care lipsesc
//   până le scrie: salarii, contribuții, dobânzi, amortizare.
//
// Cine citește raportul trebuie să vadă că e estimare. De-aia funcția
// întoarce și lista operațiunilor, iar pagina o afișează — nu ca notă de
// subsol, ci ca tabel, cu sumele la vedere.
const { clasa } = require("./plan-conturi");

const BANI = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Ce vine din documente, deci există deja pentru luna în curs și NU se
// estimează. Restul notelor lunii trecute se repetă.
const DIN_DOCUMENTE = new Set(["factura_vanzare", "factura_achizitie", "incasare", "plata_furnizor"]);

const TVA_COLECTATA = "4427";
const TVA_DEDUCTIBILA = "4426";
const TVA_DE_PLATA = "4423";
const TVA_DE_RECUPERAT = "4424";
const REZULTAT = "121";

function ultimaZiDinLuna(iso) {
  const [an, luna] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(an, luna, 0)).getUTCDate();
}
function eLunaIntreaga(panaLa) {
  return Number(String(panaLa).slice(8, 10)) >= ultimaZiDinLuna(panaLa);
}
// Luna plină dinaintea celei în care cade `panaLa`.
function lunaAnterioara(panaLa) {
  const an = Number(String(panaLa).slice(0, 4));
  const luna = Number(String(panaLa).slice(5, 7));
  const a = luna === 1 ? an - 1 : an;
  const l = luna === 1 ? 12 : luna - 1;
  const ll = String(l).padStart(2, "0");
  return { de: `${a}-${ll}-01`, la: `${a}-${ll}-${String(ultimaZiDinLuna(`${a}-${ll}-01`)).padStart(2, "0")}` };
}
const inceputLunii = (iso) => String(iso).slice(0, 7) + "-01";

// Indexul conturilor, ca să putem adăuga mișcări pe conturi care încă nu
// apar în balanță (121 și 4423 de obicei nu apar până nu închizi ceva).
function index(conturi) {
  const m = new Map();
  for (const c of conturi) m.set(String(c.cont), c);
  return m;
}

function randNou(cont, plan) {
  const info = (plan && plan.get(String(cont))) || {};
  return {
    cont: String(cont),
    denumire: info.denumire || "(cont necunoscut în planul de conturi)",
    functiune: info.functiune || "B",
    clasa: clasa(cont),
    siD: 0, siC: 0, rD: 0, rC: 0, tsD: 0, tsC: 0, sfD: 0, sfC: 0, nr: 0,
  };
}

// Adaugă o mișcare pe rulajele perioadei și reface totalurile rândului.
function misca(idx, conturi, plan, cont, debit, credit) {
  const cheie = String(cont);
  let r = idx.get(cheie);
  if (!r) {
    r = randNou(cheie, plan);
    idx.set(cheie, r);
    conturi.push(r);
  }
  r.rD = BANI(r.rD + (Number(debit) || 0));
  r.rC = BANI(r.rC + (Number(credit) || 0));
  return r;
}

function recalculeaza(conturi) {
  const total = { siD: 0, siC: 0, rD: 0, rC: 0, tsD: 0, tsC: 0, sfD: 0, sfC: 0 };
  for (const c of conturi) {
    c.tsD = BANI(c.siD + c.rD);
    c.tsC = BANI(c.siC + c.rC);
    const net = BANI(c.tsD - c.tsC);
    c.sfD = net > 0 ? net : 0;
    c.sfC = net < 0 ? -net : 0;
    for (const k of Object.keys(total)) total[k] = BANI(total[k] + c[k]);
  }
  return total;
}

// ---- 1. estimarea lunii în curs ----------------------------------------
//
// `linii` sunt înregistrările lunii pline anterioare, deja filtrate de
// apelant la ce nu vine din documente. Se repetă toate, în bloc: suma lor e
// echilibrată, deci balanța rămâne închisă.
function estimeaza(conturi, plan, linii, { contCurente }) {
  const idx = index(conturi);
  const peCont = new Map();
  for (const l of linii || []) {
    const cont = String(l.cont);
    // Dacă în luna curentă contul ăsta s-a mișcat deja, înseamnă că cineva a
    // scris nota — n-o mai estimăm peste ea.
    if (contCurente && contCurente.has(cont)) continue;
    if (!peCont.has(cont)) peCont.set(cont, { cont, debit: 0, credit: 0, denumire: "" });
    const g = peCont.get(cont);
    g.debit = BANI(g.debit + Number(l.debit || 0));
    g.credit = BANI(g.credit + Number(l.credit || 0));
  }
  const operatii = [];
  for (const g of peCont.values()) {
    if (!(g.debit > 0 || g.credit > 0)) continue;
    const r = misca(idx, conturi, plan, g.cont, g.debit, g.credit);
    operatii.push({ cont: g.cont, denumire: r.denumire, debit: g.debit, credit: g.credit });
  }
  return operatii;
}

// ---- 2. închiderea TVA --------------------------------------------------
function inchideTva(conturi, plan) {
  const idx = index(conturi);
  const colectata = idx.get(TVA_COLECTATA);
  const deductibila = idx.get(TVA_DEDUCTIBILA);
  const soldC = colectata ? BANI(colectata.tsC - colectata.tsD) : 0;
  const soldD = deductibila ? BANI(deductibila.tsD - deductibila.tsC) : 0;
  if (soldC === 0 && soldD === 0) return [];

  const operatii = [];
  if (soldC !== 0) {
    misca(idx, conturi, plan, TVA_COLECTATA, soldC, 0);
    operatii.push({ cont: TVA_COLECTATA, denumire: "TVA colectată, închisă", debit: soldC, credit: 0 });
  }
  if (soldD !== 0) {
    misca(idx, conturi, plan, TVA_DEDUCTIBILA, 0, soldD);
    operatii.push({ cont: TVA_DEDUCTIBILA, denumire: "TVA deductibilă, închisă", debit: 0, credit: soldD });
  }
  const dif = BANI(soldC - soldD);
  if (dif > 0) {
    misca(idx, conturi, plan, TVA_DE_PLATA, 0, dif);
    operatii.push({ cont: TVA_DE_PLATA, denumire: "TVA de plată", debit: 0, credit: dif });
  } else if (dif < 0) {
    misca(idx, conturi, plan, TVA_DE_RECUPERAT, -dif, 0);
    operatii.push({ cont: TVA_DE_RECUPERAT, denumire: "TVA de recuperat", debit: -dif, credit: 0 });
  }
  recalculeaza(conturi);
  return operatii;
}

// ---- 3. închiderea claselor 6 și 7 în 121 -------------------------------
function inchideVenituriSiCheltuieli(conturi, plan) {
  const idx = index(conturi);
  const operatii = [];
  let cheltuieli = 0;
  let venituri = 0;

  for (const c of conturi.slice()) {
    const cl = clasa(c.cont);
    if (cl !== "6" && cl !== "7") continue;
    const net = BANI(c.tsD - c.tsC);
    if (net === 0) continue;
    if (cl === "6") {
      // cheltuielile stau în debit: se creditează ca să rămână pe zero
      misca(idx, conturi, plan, c.cont, net < 0 ? -net : 0, net > 0 ? net : 0);
      cheltuieli = BANI(cheltuieli + net);
    } else {
      // veniturile stau în credit: se debitează
      misca(idx, conturi, plan, c.cont, net < 0 ? -net : 0, net > 0 ? net : 0);
      venituri = BANI(venituri - net);
    }
    operatii.push({ cont: c.cont, denumire: c.denumire, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 });
  }

  if (cheltuieli !== 0 || venituri !== 0) {
    // 121 primește oglinda: cheltuielile în debit, veniturile în credit.
    misca(idx, conturi, plan, REZULTAT, cheltuieli, venituri);
    operatii.push({ cont: REZULTAT, denumire: "Profit sau pierdere", debit: cheltuieli, credit: venituri });
  }
  recalculeaza(conturi);
  return { operatii, cheltuieli, venituri, rezultat: BANI(venituri - cheltuieli) };
}

// ---- tot drumul, într-un singur apel ------------------------------------
function inchide({ conturi, plan, panaLa, liniiAnterioare, conturiMiscateLunaCurenta }) {
  // Lucrăm pe copii: rândurile venite din conta.balanta() nu se modifică.
  const lucru = (conturi || []).map((c) => Object.assign({}, c));
  const lunaIncompleta = !eLunaIntreaga(panaLa);

  const estimari = lunaIncompleta
    ? estimeaza(lucru, plan, liniiAnterioare, { contCurente: conturiMiscateLunaCurenta })
    : [];
  // Recalculăm mereu, nu doar când s-au adăugat estimări: închiderea de TVA
  // citește tsD/tsC, iar dacă rămân cele venite din balanța brută după ce
  // am atins rulajele, închide pe cifre vechi.
  recalculeaza(lucru);

  const tva = inchideTva(lucru, plan);
  const rezultat = inchideVenituriSiCheltuieli(lucru, plan);
  const total = recalculeaza(lucru);

  return {
    conturi: lucru,
    total,
    estimari,
    tva,
    inchideri: rezultat.operatii,
    cheltuieli: rezultat.cheltuieli,
    venituri: rezultat.venituri,
    rezultat: rezultat.rezultat,
    lunaIncompleta,
    referinta: lunaAnterioara(panaLa),
    echilibrat: Math.abs(BANI(total.rD - total.rC)) <= 0.01 && Math.abs(BANI(total.sfD - total.sfC)) <= 0.01,
  };
}

module.exports = {
  inchide, estimeaza, inchideTva, inchideVenituriSiCheltuieli, recalculeaza,
  eLunaIntreaga, lunaAnterioara, inceputLunii, ultimaZiDinLuna, BANI,
  DIN_DOCUMENTE, TVA_COLECTATA, TVA_DEDUCTIBILA, TVA_DE_PLATA, TVA_DE_RECUPERAT, REZULTAT,
};
