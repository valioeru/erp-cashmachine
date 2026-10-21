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
const REZULTAT_REPORTAT = "117";
const CONT_CLARIFICARE = "473";

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
// PRORATA, nu luna întreagă.
//
// Prima variantă punea salariile lunii trecute în întregime, din prima zi a
// lunii curente. Pe 3 ale lunii rezultatul arăta o pierdere de cât costă o
// lună de salarii, deși trecuseră trei zile — exact genul de cifră care te
// face să iei o decizie proastă dimineața. Acum se ia partea scursă: la 21
// din 30 de zile, 70% din salariile lunii trecute.
//
// Împărțitorul e numărul de zile al lunii de referință, nu al celei curente:
// altfel februarie ar scoate 110% din ianuarie.
function prorata(panaLa, referinta) {
  const zileScurse = Number(String(panaLa).slice(8, 10));
  const zileReferinta = ultimaZiDinLuna(referinta.de);
  if (!(zileScurse > 0) || !(zileReferinta > 0)) return 1;
  return Math.min(1, zileScurse / zileReferinta);
}

function estimeaza(conturi, plan, linii, { contCurente, factor }) {
  const idx = index(conturi);
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const peCont = new Map();
  for (const l of linii || []) {
    const cont = String(l.cont);
    // Dacă în luna curentă contul ăsta s-a mișcat deja, înseamnă că cineva a
    // scris nota — n-o mai estimăm peste ea.
    if (contCurente && contCurente.has(cont)) continue;
    if (!peCont.has(cont)) peCont.set(cont, { cont, debit: 0, credit: 0, denumire: "" });
    const g = peCont.get(cont);
    g.debit = BANI(g.debit + Number(l.debit || 0) * f);
    g.credit = BANI(g.credit + Number(l.credit || 0) * f);
  }
  const operatii = [];
  for (const g of peCont.values()) {
    if (!(g.debit > 0 || g.credit > 0)) continue;
    const r = misca(idx, conturi, plan, g.cont, g.debit, g.credit);
    operatii.push({ cont: g.cont, denumire: r.denumire, debit: g.debit, credit: g.credit });
  }
  // Rotunjirea pe fiecare cont poate lăsa un ban-doi diferență între debit și
  // credit. Îl punem pe contul cel mai mare din lot, ca balanța să închidă la
  // bănuț — nu-l lăsăm să treacă mai departe, fiindcă apoi nu se mai știe de
  // unde a apărut.
  const d = BANI(operatii.reduce((a, o) => a + o.debit, 0));
  const c = BANI(operatii.reduce((a, o) => a + o.credit, 0));
  const dif = BANI(d - c);
  if (dif !== 0 && operatii.length) {
    const tinta = operatii.slice().sort((a, b) => b.debit + b.credit - (a.debit + a.credit))[0];
    if (dif > 0) { misca(idx, conturi, plan, tinta.cont, 0, dif); tinta.credit = BANI(tinta.credit + dif); }
    else { misca(idx, conturi, plan, tinta.cont, -dif, 0); tinta.debit = BANI(tinta.debit - dif); }
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

// ---- 4. închiderea lui 121 în 117 --------------------------------------
//
// Ultimul pas, ca balanța să nu mai aibă NIMIC deschis: rezultatul trece din
// 121 în 117 (Rezultatul reportat), deci se citește direct în capitaluri.
//
// În contabilitatea adevărată asta se face o dată pe an, nu zilnic. Aici se
// face în raport, pe estimare, fiindcă întrebarea e „unde stau azi", nu „ce
// depun la finanțe". Registrul rămâne neatins, ca la toți pașii de mai sus.
function inchideRezultatul(conturi, plan) {
  const idx = index(conturi);
  const r = idx.get(REZULTAT);
  if (!r) return [];
  const net = BANI(r.tsD - r.tsC);
  if (net === 0) return [];
  // net < 0 înseamnă profit (121 are sold creditor).
  misca(idx, conturi, plan, REZULTAT, net < 0 ? -net : 0, net > 0 ? net : 0);
  misca(idx, conturi, plan, REZULTAT_REPORTAT, net > 0 ? net : 0, net < 0 ? -net : 0);
  const operatii = [
    { cont: REZULTAT, denumire: "Profit sau pierdere, închis", debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 },
    { cont: REZULTAT_REPORTAT, denumire: "Rezultatul reportat", debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 },
  ];
  recalculeaza(conturi);
  return operatii;
}

// ---- 5. diferența rămasă, pusă pe 473 -----------------------------------
//
// Cererea lui Vali: „pentru diferențe mici fă o notă internă și închide, nu
// lăsa așa — scrie că ai făcut asta, dar închide balanța."
//
// Se pune pe 473, Decontări din operațiuni în curs de clarificare — contul
// care există exact pentru asta și pe care îl folosește deja motorul
// contabil când nu știe unde să pună ceva.
//
// SE SCRIE CÂT A FOST. O diferență închisă în tăcere nu dispare, doar se
// mută undeva unde n-o mai caută nimeni. De-aia funcția întoarce suma, iar
// pagina o arată — galben sub prag, roșu peste. Peste prag nu mai e
// „diferență mică", e o problemă care trebuie căutată, chiar dacă balanța
// arată acum frumos.
const PRAG_DIFERENTA = 100; // lei

function inchideDiferenta(conturi, plan) {
  const total = recalculeaza(conturi);
  const difInitiale = BANI(total.siD - total.siC);
  const difRulaje = BANI(total.rD - total.rC);
  if (difInitiale === 0 && difRulaje === 0) return null;

  const idx = index(conturi);
  let r = idx.get(CONT_CLARIFICARE);
  if (!r) {
    r = randNou(CONT_CLARIFICARE, plan);
    idx.set(CONT_CLARIFICARE, r);
    conturi.push(r);
  }

  // Se repară acolo unde e gaura, nu oriunde.
  //
  // Prima variantă punea totul pe rulaje. O balanță venită cu soldurile
  // inițiale nepotrivite ieșea atunci cu soldurile finale închise și cu
  // rulajele deschise — adică exact aceeași diferență, mutată într-o
  // coloană în care nimeni nu se uită. Un sold inițial strâmb se repară în
  // soldul inițial.
  if (difInitiale > 0) r.siC = BANI(r.siC + difInitiale);
  else if (difInitiale < 0) r.siD = BANI(r.siD - difInitiale);
  if (difRulaje > 0) r.rC = BANI(r.rC + difRulaje);
  else if (difRulaje < 0) r.rD = BANI(r.rD - difRulaje);

  recalculeaza(conturi);
  const suma = BANI(Math.abs(difInitiale) + Math.abs(difRulaje));
  return {
    cont: CONT_CLARIFICARE,
    denumire: "Decontări din operațiuni în curs de clarificare",
    suma,
    pe_solduri_initiale: Math.abs(difInitiale),
    pe_rulaje: Math.abs(difRulaje),
    peste_prag: suma > PRAG_DIFERENTA,
  };
}

// ---- tot drumul, într-un singur apel ------------------------------------
function inchide({ conturi, plan, panaLa, liniiAnterioare, conturiMiscateLunaCurenta, inchide121 = true }) {
  // Lucrăm pe copii: rândurile venite din conta.balanta() nu se modifică.
  const lucru = (conturi || []).map((c) => Object.assign({}, c));
  const lunaIncompleta = !eLunaIntreaga(panaLa);
  const referinta = lunaAnterioara(panaLa);
  const factor = lunaIncompleta ? prorata(panaLa, referinta) : 1;

  const estimari = lunaIncompleta
    ? estimeaza(lucru, plan, liniiAnterioare, { contCurente: conturiMiscateLunaCurenta, factor })
    : [];
  // Recalculăm mereu, nu doar când s-au adăugat estimări: închiderea de TVA
  // citește tsD/tsC, iar dacă rămân cele venite din balanța brută după ce
  // am atins rulajele, închide pe cifre vechi.
  recalculeaza(lucru);

  const tva = inchideTva(lucru, plan);
  const rezultat = inchideVenituriSiCheltuieli(lucru, plan);
  const reportat = inchide121 ? inchideRezultatul(lucru, plan) : [];
  // Ultimul lucru, după toate închiderile: ce a mai rămas nepotrivit pleacă
  // pe 473, iar suma se raportează. Balanța iese închisă, dar scrie pe ea cu
  // ce preț.
  const diferenta = inchideDiferenta(lucru, plan);
  const total = recalculeaza(lucru);

  return {
    conturi: lucru,
    total,
    estimari,
    tva,
    inchideri: rezultat.operatii,
    reportat,
    diferenta,
    cheltuieli: rezultat.cheltuieli,
    venituri: rezultat.venituri,
    rezultat: rezultat.rezultat,
    lunaIncompleta,
    factor: BANI(factor * 100),
    zileScurse: Number(String(panaLa).slice(8, 10)),
    zileReferinta: ultimaZiDinLuna(referinta.de),
    referinta,
    echilibrat:
      Math.abs(BANI(total.siD - total.siC)) <= 0.01 &&
      Math.abs(BANI(total.rD - total.rC)) <= 0.01 &&
      Math.abs(BANI(total.sfD - total.sfC)) <= 0.01,
  };
}

// Ziua de ieri: raportul se cere pe ea, nu pe azi. O zi în curs n-are
// facturile introduse și nici încasările confirmate, deci „la zi" pe ziua
// de azi arată mereu mai prost decât e.
function ieri(azi) {
  const d = new Date(String(azi) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  inchide, estimeaza, inchideTva, inchideVenituriSiCheltuieli, inchideRezultatul, inchideDiferenta, recalculeaza,
  eLunaIntreaga, lunaAnterioara, inceputLunii, ultimaZiDinLuna, prorata, ieri, BANI,
  DIN_DOCUMENTE, TVA_COLECTATA, TVA_DEDUCTIBILA, TVA_DE_PLATA, TVA_DE_RECUPERAT, REZULTAT, REZULTAT_REPORTAT, CONT_CLARIFICARE, PRAG_DIFERENTA,
};
