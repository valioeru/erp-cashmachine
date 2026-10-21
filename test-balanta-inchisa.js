"use strict";
// Balanța închisă la zi — estimarea care face rezultatul vizibil la mijlocul
// lunii.
//
// CE APĂRĂ, în ordinea în care doare dacă se strică:
//
//   • BALANȚA RĂMÂNE ÎNCHISĂ. Orice operațiune adăugată — estimare, decontare
//     de TVA, închidere în 121 — pune debit egal cu credit. O balanță care
//     nu se verifică nu e o estimare proastă, e o foaie de hârtie fără
//     valoare, iar greșeala se vede abia la bancă.
//
//   • SE REPETĂ NOTE, NU CONTURI. Dacă s-ar lua „contul 641 a avut luna
//     trecută 50.000" și s-ar adăuga singur, i-ar lipsi contrapartida din
//     421 și balanța s-ar strâmba exact cu suma estimată.
//
//   • NU SE ESTIMEAZĂ PESTE CE EXISTĂ. Un cont care s-a mișcat deja în luna
//     curentă are nota scrisă; repetată, ar număra salariile de două ori.
//
//   • NU SE ESTIMEAZĂ DELOC PE LUNĂ ÎNTREAGĂ. La 31 ale lunii nu mai e nimic
//     de ghicit, iar o estimare acolo ar dubla luna reală.
//
//   • RÂNDURILE PRIMITE NU SE MODIFICĂ. Raportul brut și cel închis se cer
//     una după alta în aceeași pagină; dacă închiderea ar scrie în rândurile
//     venite din motor, balanța brută s-ar vedea deja închisă.
//
// Rulează fără bază de date: lib/balanta-inchisa.js nu cere decât planul de
// conturi, iar toată logica e pe cifre date.
const path = require("path");
const i = require(path.join(__dirname, "lib", "balanta-inchisa.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const aprox = (eticheta, avut, asteptat) => {
  if (Math.abs(Number(avut) - Number(asteptat)) > 0.011) rau(eticheta, "am " + avut + ", așteptam " + asteptat);
  else ok(eticheta + " = " + asteptat);
};

const plan = new Map([
  ["121", { denumire: "Profit sau pierdere", functiune: "B" }],
  ["4423", { denumire: "TVA de plată", functiune: "P" }],
  ["4424", { denumire: "TVA de recuperat", functiune: "A" }],
  ["421", { denumire: "Personal - salarii datorate", functiune: "P" }],
  ["641", { denumire: "Cheltuieli cu salariile", functiune: "A" }],
  ["666", { denumire: "Cheltuieli privind dobânzile", functiune: "A" }],
]);

// Un rând de balanță, cu soldurile deja calculate ca în conta.balanta().
function cont(simbol, denumire, { siD = 0, siC = 0, rD = 0, rC = 0 } = {}) {
  const tsD = siD + rD, tsC = siC + rC, net = Math.round((tsD - tsC) * 100) / 100;
  return {
    cont: simbol, denumire, functiune: "B", clasa: String(simbol).charAt(0),
    siD, siC, rD, rC, tsD, tsC, sfD: net > 0 ? net : 0, sfC: net < 0 ? -net : 0, nr: 1,
  };
}
const gaseste = (lista, simbol) => lista.find((x) => String(x.cont) === simbol) || null;
const echilibrat = (t) => Math.abs(t.rD - t.rC) <= 0.011 && Math.abs(t.sfD - t.sfC) <= 0.011 && Math.abs(t.siD - t.siC) <= 0.011;

console.log("\nÎnchiderea claselor 6 și 7:");
{
  const conturi = [
    cont("4111", "Clienți", { rD: 119000 }),
    cont("707", "Venituri din vânzarea mărfurilor", { rC: 100000 }),
    cont("4427", "TVA colectată", { rC: 19000 }),
    cont("607", "Cheltuieli privind mărfurile", { rD: 60000 }),
    cont("401", "Furnizori", { rC: 71400 }),
    cont("4426", "TVA deductibilă", { rD: 11400 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  egal("clasa 7 rămâne pe zero", gaseste(r.conturi, "707").sfC + gaseste(r.conturi, "707").sfD, 0);
  egal("clasa 6 rămâne pe zero", gaseste(r.conturi, "607").sfC + gaseste(r.conturi, "607").sfD, 0);
  aprox("venituri strânse", r.venituri, 100000);
  aprox("cheltuieli strânse", r.cheltuieli, 60000);
  aprox("rezultatul estimat", r.rezultat, 40000);
  egal("121 nu rămâne deschis, trece în 117", gaseste(r.conturi, "121").sfC + gaseste(r.conturi, "121").sfD, 0);
  aprox("profitul se vede în 117", gaseste(r.conturi, "117").sfC, 40000);
  if (!echilibrat(r.total)) rau("balanța nu mai închide după închiderea claselor", JSON.stringify(r.total));
  else ok("balanța închide după închiderea claselor");
  egal("raportul spune singur că e echilibrat", r.echilibrat, true);
}

console.log("\nPierderea, nu doar profitul:");
{
  const conturi = [
    cont("707", "Venituri", { rC: 10000 }),
    cont("4111", "Clienți", { rD: 10000 }),
    cont("607", "Cheltuieli", { rD: 25000 }),
    cont("401", "Furnizori", { rC: 25000 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  aprox("rezultat negativ", r.rezultat, -15000);
  aprox("pierderea se vede în 117, pe debit", gaseste(r.conturi, "117").sfD, 15000);
  if (!echilibrat(r.total)) rau("balanța nu închide pe pierdere");
  else ok("balanța închide și pe pierdere");
}

console.log("\nDecontarea TVA:");
{
  const conturi = [
    cont("4427", "TVA colectată", { rC: 19000 }),
    cont("4426", "TVA deductibilă", { rD: 11400 }),
    cont("4111", "Clienți", { rD: 19000 }),
    cont("401", "Furnizori", { rC: 11400 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  egal("TVA colectată rămâne pe zero", gaseste(r.conturi, "4427").sfC + gaseste(r.conturi, "4427").sfD, 0);
  egal("TVA deductibilă rămâne pe zero", gaseste(r.conturi, "4426").sfD + gaseste(r.conturi, "4426").sfC, 0);
  aprox("diferența ajunge în 4423, de plată", gaseste(r.conturi, "4423").sfC, 7600);
  if (gaseste(r.conturi, "4424")) rau("s-a născut și 4424 degeaba");
  else ok("nu s-a atins 4424");
  if (!echilibrat(r.total)) rau("balanța nu închide după decontarea TVA");
  else ok("balanța închide după decontarea TVA");
}
{
  const conturi = [
    cont("4427", "TVA colectată", { rC: 2000 }),
    cont("4426", "TVA deductibilă", { rD: 9000 }),
    cont("4111", "Clienți", { rD: 2000 }),
    cont("401", "Furnizori", { rC: 9000 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  aprox("deductibilă mai mare → 4424, de recuperat", gaseste(r.conturi, "4424").sfD, 7000);
  if (!echilibrat(r.total)) rau("balanța nu închide pe TVA de recuperat");
  else ok("balanța închide pe TVA de recuperat");
}

console.log("\nEstimarea lunii în curs:");
{
  const conturi = [
    cont("5121", "Bancă", { siD: 100000 }),
    cont("1012", "Capital", { siC: 100000 }),
  ];
  // Luna trecută: salarii 641/421 și o dobândă 666/5121. Perechi echilibrate.
  const liniiAnterioare = [
    { cont: "641", debit: 50000, credit: 0 },
    { cont: "421", debit: 0, credit: 50000 },
    { cont: "666", debit: 1200, credit: 0 },
    { cont: "5121", debit: 0, credit: 1200 },
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-21", liniiAnterioare, conturiMiscateLunaCurenta: new Set() });
  egal("luna e recunoscută ca incompletă", r.lunaIncompleta, true);
  egal("referința e luna plină dinainte", r.referinta.de.slice(0, 7), "2026-09");
  egal("s-au estimat patru conturi", r.estimari.length, 4);
  // 21 din 30 de zile ale lunii de referință: 51.200 × 0,7
  aprox("salariile intră proporțional cu zilele scurse", r.cheltuieli, 35840);
  aprox("rezultatul e pierderea estimată, tot proporțional", r.rezultat, -35840);
  if (!echilibrat(r.total)) rau("estimarea a strâmbat balanța", JSON.stringify(r.total));
  else ok("balanța închide și după estimare");
}
{
  // Salariile lunii curente sunt deja scrise: nu le mai estimăm peste.
  const conturi = [
    cont("641", "Cheltuieli cu salariile", { rD: 52000 }),
    cont("421", "Salarii datorate", { rC: 52000 }),
  ];
  const liniiAnterioare = [
    { cont: "641", debit: 50000, credit: 0 },
    { cont: "421", debit: 0, credit: 50000 },
  ];
  const r = i.inchide({
    conturi, plan, panaLa: "2026-10-21", liniiAnterioare,
    conturiMiscateLunaCurenta: new Set(["641", "421"]),
  });
  egal("nu se estimează peste nota deja scrisă", r.estimari.length, 0);
  aprox("cheltuiala rămâne cea reală, nu dublată", r.cheltuieli, 52000);
}
{
  // La sfârșit de lună nu mai e nimic de ghicit.
  const conturi = [cont("5121", "Bancă", { siD: 1000 }), cont("1012", "Capital", { siC: 1000 })];
  const r = i.inchide({
    conturi, plan, panaLa: "2026-09-30",
    liniiAnterioare: [{ cont: "641", debit: 50000, credit: 0 }, { cont: "421", debit: 0, credit: 50000 }],
    conturiMiscateLunaCurenta: new Set(),
  });
  egal("pe lună întreagă nu se estimează nimic", [r.lunaIncompleta, r.estimari.length], [false, 0]);
}

console.log("\nRândurile primite rămân neatinse:");
{
  const conturi = [
    cont("707", "Venituri", { rC: 1000 }),
    cont("4111", "Clienți", { rD: 1000 }),
  ];
  const inainte = JSON.stringify(conturi);
  i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  if (JSON.stringify(conturi) !== inainte) rau("închiderea a scris în rândurile originale");
  else ok("balanța brută rămâne cum a venit din motor");
}

console.log("\nTotul la un loc, ca în pagină:");
{
  const conturi = [
    cont("5121", "Bancă", { siD: 250000, rD: 119000, rC: 71400 }),
    cont("1012", "Capital", { siC: 250000 }),
    cont("4111", "Clienți", { rD: 119000, rC: 119000 }),
    cont("707", "Venituri din vânzarea mărfurilor", { rC: 100000 }),
    cont("4427", "TVA colectată", { rC: 19000 }),
    cont("607", "Cheltuieli privind mărfurile", { rD: 60000 }),
    cont("401", "Furnizori", { rD: 71400, rC: 71400 }),
    cont("4426", "TVA deductibilă", { rD: 11400 }),
  ];
  const r = i.inchide({
    conturi, plan, panaLa: "2026-10-21",
    liniiAnterioare: [
      { cont: "641", debit: 40000, credit: 0 },
      { cont: "421", debit: 0, credit: 40000 },
    ],
    conturiMiscateLunaCurenta: new Set(),
  });
  const deschise = r.conturi.filter((c) => ["6", "7"].includes(String(c.cont).charAt(0)) && (c.sfD > 0.01 || c.sfC > 0.01));
  egal("niciun cont din clasele 6 și 7 nu rămâne deschis", deschise.map((c) => c.cont), []);
  const tvaDeschis = ["4426", "4427"].filter((x) => { const c = gaseste(r.conturi, x); return c && (c.sfD > 0.01 || c.sfC > 0.01); });
  egal("TVA-ul nu rămâne deschis", tvaDeschis, []);
  // salarii 40.000 × 21/30 = 28.000 → 100.000 - 60.000 - 28.000
  aprox("rezultat = venituri - marfă - salarii proratate", r.rezultat, 12000);
  if (!echilibrat(r.total)) rau("balanța completă nu închide", JSON.stringify(r.total));
  else ok("balanța completă închide");
}

console.log("\nProrata pe zilele scurse:");
{
  // 21 de zile din octombrie, raportate la septembrie care are 30 → 70%.
  aprox("21 din 30 de zile = 70%", i.prorata("2026-10-21", { de: "2026-09-01" }), 0.7);
  aprox("nu trece niciodată de 100%", i.prorata("2026-03-31", { de: "2026-02-01" }), 1);
  const conturi = [cont("5121", "Bancă", { siD: 100000 }), cont("1012", "Capital", { siC: 100000 })];
  const liniiAnterioare = [
    { cont: "641", debit: 30000, credit: 0 },
    { cont: "421", debit: 0, credit: 30000 },
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-21", liniiAnterioare, conturiMiscateLunaCurenta: new Set() });
  egal("raportul spune ce prorata a folosit", r.factor, 70);
  egal("și din câte zile", [r.zileScurse, r.zileReferinta], [21, 30]);
  aprox("salariile intră proporțional, nu întregi", r.cheltuieli, 21000);
  if (!echilibrat(r.total)) rau("prorata a strâmbat balanța", JSON.stringify(r.total));
  else ok("balanța închide și cu prorata");
}
{
  // Rotunjirea pe fiecare cont nu are voie să lase balanța deschisă.
  const conturi = [cont("5121", "Bancă", { siD: 1 }), cont("1012", "Capital", { siC: 1 })];
  const liniiAnterioare = [
    { cont: "641", debit: 1000.01, credit: 0 },
    { cont: "6451", debit: 333.33, credit: 0 },
    { cont: "421", debit: 0, credit: 1333.34 },
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-07", liniiAnterioare, conturiMiscateLunaCurenta: new Set() });
  if (!echilibrat(r.total)) rau("rotunjirea a lăsat balanța deschisă", JSON.stringify(r.total));
  else ok("rotunjirea pe conturi nu lasă balanța deschisă");
}

console.log("\nÎnchiderea lui 121 în 117:");
{
  const conturi = [
    cont("4111", "Clienți", { rD: 100000 }),
    cont("707", "Venituri", { rC: 100000 }),
    cont("607", "Cheltuieli", { rD: 60000 }),
    cont("401", "Furnizori", { rC: 60000 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  egal("121 nu mai rămâne deschis", gaseste(r.conturi, "121").sfD + gaseste(r.conturi, "121").sfC, 0);
  aprox("rezultatul a trecut în 117", gaseste(r.conturi, "117").sfC, 40000);
  egal("se raportează ce s-a mutat", r.reportat.length, 2);
  if (!echilibrat(r.total)) rau("balanța nu închide după mutarea în 117");
  else ok("balanța închide după mutarea în 117");

  const fara = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [], inchide121: false });
  aprox("se poate și fără, dacă vrem 121 la vedere", gaseste(fara.conturi, "121").sfC, 40000);
}

console.log("\nDiferența rămasă, pusă pe 473 și spusă:");
{
  // Balanță strâmbă intenționat cu 7 lei: un cont fără contrapartidă.
  const conturi = [
    cont("5121", "Bancă", { siD: 1007 }),
    cont("1012", "Capital", { siC: 1000 }),
  ];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  if (!r.diferenta) rau("diferența n-a fost nici închisă, nici raportată");
  else {
    aprox("diferența ajunge pe 473", r.diferenta.suma, 7);
    egal("și se spune pe ce cont", r.diferenta.cont, "473");
    egal("sub prag, deci nu e alarmă", r.diferenta.peste_prag, false);
  }
  egal("balanța iese închisă", r.echilibrat, true);
}
{
  const conturi = [cont("5121", "Bancă", { siD: 51000 }), cont("1012", "Capital", { siC: 1000 })];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  aprox("o diferență mare se închide tot", r.diferenta.suma, 50000);
  egal("dar se marchează ca peste prag", r.diferenta.peste_prag, true);
  egal("și balanța e închisă", r.echilibrat, true);
}
{
  const conturi = [cont("5121", "Bancă", { siD: 1000 }), cont("1012", "Capital", { siC: 1000 })];
  const r = i.inchide({ conturi, plan, panaLa: "2026-10-31", liniiAnterioare: [] });
  egal("o balanță deja închisă nu primește nicio notă pe 473", r.diferenta, null);
}

console.log("\nZiua de ieri:");
egal("ieri de 21.10", i.ieri("2026-10-21"), "2026-10-20");
egal("ieri de 1 ale lunii trece în luna trecută", i.ieri("2026-10-01"), "2026-09-30");
egal("ieri de 1 ianuarie trece în anul trecut", i.ieri("2027-01-01"), "2026-12-31");

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
