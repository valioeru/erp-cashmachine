"use strict";
// Planul de conturi general românesc (OMFP 1802/2014) — conturile sintetice
// folosite curent de o firmă de comerț/servicii. Nu e planul complet (are
// câteva sute de conturi, multe irelevante aici), dar acoperă tot ce poate
// genera ERP-ul, plus conturile care apar în orice balanță de la contabil.
//
// Funcțiunea contabilă ("functiune"):
//   A = cont de activ      (crește pe debit,  sold final debitor)
//   P = cont de pasiv      (crește pe credit, sold final creditor)
//   B = bifuncțional       (poate avea sold în oricare parte)
//
// Funcțiunea contează pentru balanță: soldul final se pune în coloana D sau C
// după semnul rulajului cumulat, iar pentru conturile bifuncționale (ex. 121
// „Profit sau pierdere", 473) partea depinde de rezultatul efectiv.

const CONTURI = [
  // --- Clasa 1: Conturi de capitaluri -----------------------------------
  ["1012", "Capital subscris vărsat", "P"],
  ["1061", "Rezerve legale", "P"],
  ["1068", "Alte rezerve", "P"],
  ["117", "Rezultatul reportat", "B"],
  ["121", "Profit sau pierdere", "B"],
  ["129", "Repartizarea profitului", "A"],
  ["1621", "Credite bancare pe termen lung", "P"],
  ["167", "Alte împrumuturi și datorii asimilate", "P"],
  ["1687", "Dobânzi aferente altor împrumuturi", "P"],

  // --- Clasa 2: Imobilizări ---------------------------------------------
  ["203", "Cheltuieli de dezvoltare", "A"],
  ["205", "Concesiuni, brevete, licențe, mărci", "A"],
  ["208", "Alte imobilizări necorporale", "A"],
  ["2081", "Programe informatice", "A"],
  ["211", "Terenuri și amenajări de terenuri", "A"],
  ["212", "Construcții", "A"],
  ["213", "Instalații tehnice și mijloace de transport", "A"],
  ["2131", "Echipamente tehnologice", "A"],
  ["2133", "Mijloace de transport", "A"],
  ["214", "Mobilier, aparatură birotică", "A"],
  ["231", "Imobilizări corporale în curs de execuție", "A"],
  ["267", "Creanțe imobilizate", "A"],
  ["2801", "Amortizarea cheltuielilor de dezvoltare", "P"],
  ["2805", "Amortizarea concesiunilor, brevetelor, licențelor", "P"],
  ["2808", "Amortizarea altor imobilizări necorporale", "P"],
  ["2812", "Amortizarea construcțiilor", "P"],
  ["2813", "Amortizarea instalațiilor și mijloacelor de transport", "P"],
  ["2814", "Amortizarea altor imobilizări corporale", "P"],

  // --- Clasa 3: Stocuri --------------------------------------------------
  ["301", "Materii prime", "A"],
  ["302", "Materiale consumabile", "A"],
  ["3021", "Materiale auxiliare", "A"],
  ["3022", "Combustibili", "A"],
  ["3024", "Piese de schimb", "A"],
  ["303", "Materiale de natura obiectelor de inventar", "A"],
  ["331", "Produse în curs de execuție", "A"],
  ["345", "Produse finite", "A"],
  ["346", "Produse reziduale", "A"],
  ["361", "Ambalaje", "A"],
  ["371", "Mărfuri", "A"],
  ["378", "Diferențe de preț la mărfuri", "B"],
  ["381", "Ambalaje", "A"],
  ["391", "Ajustări pentru deprecierea materiilor prime", "P"],
  ["397", "Ajustări pentru deprecierea mărfurilor", "P"],

  // --- Clasa 4: Terți ----------------------------------------------------
  ["401", "Furnizori", "P"],
  ["4011", "Furnizori interni", "P"],
  ["403", "Efecte de plătit", "P"],
  ["404", "Furnizori de imobilizări", "P"],
  ["408", "Furnizori - facturi nesosite", "P"],
  ["409", "Furnizori - debitori (avansuri acordate)", "A"],
  ["411", "Clienți", "A"],
  ["4111", "Clienți", "A"],
  ["4118", "Clienți incerți sau în litigiu", "A"],
  ["413", "Efecte de primit de la clienți", "A"],
  ["418", "Clienți - facturi de întocmit", "A"],
  ["419", "Clienți - creditori (avansuri primite)", "P"],
  ["421", "Personal - salarii datorate", "P"],
  ["423", "Personal - ajutoare materiale datorate", "P"],
  ["425", "Avansuri acordate personalului", "A"],
  ["4271", "Rețineri din salarii datorate terților", "P"],
  ["428", "Alte datorii și creanțe în legătură cu personalul", "B"],
  ["4311", "Contribuția de asigurări sociale (CAS)", "P"],
  ["4315", "Contribuția de asigurări sociale reținută (CAS)", "P"],
  ["4316", "Contribuția de asigurări sociale de sănătate (CASS)", "P"],
  ["436", "Contribuția asiguratorie pentru muncă (CAM)", "P"],
  ["4423", "TVA de plată", "P"],
  ["4424", "TVA de recuperat", "A"],
  ["4426", "TVA deductibilă", "A"],
  ["4427", "TVA colectată", "P"],
  ["4428", "TVA neexigibilă", "B"],
  ["441", "Impozitul pe profit", "P"],
  ["4411", "Impozitul pe profit", "P"],
  ["4418", "Impozitul pe venitul microîntreprinderilor", "P"],
  ["444", "Impozitul pe venituri de natura salariilor", "P"],
  ["446", "Alte impozite, taxe și vărsăminte asimilate", "P"],
  ["447", "Fonduri speciale - taxe și vărsăminte asimilate", "P"],
  ["4551", "Acționari/asociați - conturi curente", "P"],
  ["456", "Decontări cu acționarii/asociații privind capitalul", "B"],
  ["457", "Dividende de plată", "P"],
  ["461", "Debitori diverși", "A"],
  ["462", "Creditori diverși", "P"],
  ["471", "Cheltuieli înregistrate în avans", "A"],
  ["472", "Venituri înregistrate în avans", "P"],
  ["473", "Decontări din operațiuni în curs de clarificare", "B"],
  ["491", "Ajustări pentru deprecierea creanțelor - clienți", "P"],

  // --- Clasa 5: Trezorerie ----------------------------------------------
  ["5121", "Conturi la bănci în lei", "A"],
  ["5124", "Conturi la bănci în valută", "A"],
  ["5125", "Sume în curs de decontare", "A"],
  ["5191", "Credite bancare pe termen scurt", "P"],
  ["5311", "Casa în lei", "A"],
  ["5314", "Casa în valută", "A"],
  ["5328", "Alte valori (tichete, timbre)", "A"],
  ["541", "Acreditive", "A"],
  ["542", "Avansuri de trezorerie", "A"],
  ["581", "Viramente interne", "B"],

  // --- Clasa 6: Cheltuieli ----------------------------------------------
  ["601", "Cheltuieli cu materiile prime", "A"],
  ["602", "Cheltuieli cu materialele consumabile", "A"],
  ["6021", "Cheltuieli cu materialele auxiliare", "A"],
  ["6022", "Cheltuieli privind combustibilii", "A"],
  ["6024", "Cheltuieli privind piesele de schimb", "A"],
  ["603", "Cheltuieli privind obiectele de inventar", "A"],
  ["604", "Cheltuieli privind materialele nestocate", "A"],
  ["605", "Cheltuieli privind utilitățile (energie, apă)", "A"],
  ["607", "Cheltuieli privind mărfurile", "A"],
  ["608", "Cheltuieli privind ambalajele", "A"],
  ["611", "Cheltuieli cu întreținerea și reparațiile", "A"],
  ["612", "Cheltuieli cu redevențele, locațiile și chiriile", "A"],
  ["613", "Cheltuieli cu primele de asigurare", "A"],
  ["614", "Cheltuieli cu studiile și cercetările", "A"],
  ["622", "Cheltuieli cu comisioanele și onorariile", "A"],
  ["623", "Cheltuieli de protocol, reclamă și publicitate", "A"],
  ["624", "Cheltuieli cu transportul de bunuri și personal", "A"],
  ["625", "Cheltuieli cu deplasări, detașări și transferări", "A"],
  ["626", "Cheltuieli poștale și taxe de telecomunicații", "A"],
  ["627", "Cheltuieli cu serviciile bancare", "A"],
  ["628", "Alte cheltuieli cu serviciile executate de terți", "A"],
  ["635", "Cheltuieli cu alte impozite, taxe și vărsăminte", "A"],
  ["641", "Cheltuieli cu salariile personalului", "A"],
  ["645", "Cheltuieli privind asigurările și protecția socială", "A"],
  ["6451", "Contribuția unității la asigurările sociale", "A"],
  ["6455", "Contribuția asiguratorie pentru muncă", "A"],
  ["654", "Pierderi din creanțe și debitori diverși", "A"],
  ["658", "Alte cheltuieli de exploatare", "A"],
  ["665", "Cheltuieli din diferențe de curs valutar", "A"],
  ["666", "Cheltuieli privind dobânzile", "A"],
  ["6581", "Despăgubiri, amenzi și penalități", "A"],
  ["6811", "Cheltuieli de exploatare privind amortizarea imobilizărilor", "A"],
  ["6814", "Cheltuieli de exploatare privind ajustările pentru deprecierea activelor circulante", "A"],
  ["691", "Cheltuieli cu impozitul pe profit", "A"],
  ["698", "Cheltuieli cu impozitul pe venit (microîntreprinderi)", "A"],

  // --- Clasa 7: Venituri -------------------------------------------------
  ["701", "Venituri din vânzarea produselor finite", "P"],
  ["703", "Venituri din vânzarea produselor reziduale", "P"],
  ["704", "Venituri din servicii prestate", "P"],
  ["705", "Venituri din studii și cercetări", "P"],
  ["706", "Venituri din redevențe, locații și chirii", "P"],
  ["707", "Venituri din vânzarea mărfurilor", "P"],
  ["708", "Venituri din activități diverse", "P"],
  ["709", "Reduceri comerciale acordate", "A"],
  ["711", "Venituri aferente costurilor stocurilor de produse", "B"],
  ["758", "Alte venituri din exploatare", "P"],
  ["765", "Venituri din diferențe de curs valutar", "P"],
  ["766", "Venituri din dobânzi", "P"],
  ["7581", "Venituri din despăgubiri, amenzi și penalități", "P"],
];

// Conturile pe care ERP-ul le folosește în postarea automată. Ținute separat,
// într-un singur loc, ca să se poată schimba ușor dacă contabilul cere altfel
// (ex. o firmă de servicii vinde pe 704, nu pe 707).
const CONTURI_IMPLICITE = {
  clienti: "4111",
  furnizori: "401",
  banca: "5121",
  casa: "5311",
  tvaColectata: "4427",
  tvaDeductibila: "4426",
  venitMarfuri: "707",
  venitServicii: "704",
  cheltuialaMarfuri: "607",
  marfuri: "371",
  cheltuialaServicii: "628",
  salariiDatorate: "421",
  cheltuialaSalarii: "641",
  cas: "4315",
  cass: "4316",
  impozitSalarii: "444",
  clarificare: "473",
};

function clasa(simbol) {
  return String(simbol).charAt(0);
}

function grupa(simbol) {
  return String(simbol).slice(0, 2);
}

module.exports = { CONTURI, CONTURI_IMPLICITE, clasa, grupa };
