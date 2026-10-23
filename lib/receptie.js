"use strict";
// Recepția mărfii: ce a venit, cât a venit de fapt, și unde s-a pus.
//
// Patru drumuri duc marfă în depozit, și NU sunt același lucru:
//
//   furnizor          — am comandat, a venit. Lipsa e o reclamație.
//   productie         — am făcut-o noi. Lipsa e o pierdere de producție.
//   retur_tert        — clientul a trimis marfa înapoi. Poate fi stricată.
//   retur_fulfilment  — s-a întors din CT-Park. La fel.
//
// Ce apără fișierul ăsta, în ordinea în care doare:
//
//   • STOCUL NU SE SCRIE DE DOUĂ ORI. O recepție finalizată a doua oară
//     (dublu click, buton apăsat din două tab-uri, cineva care „verifică
//     dacă a mers") ar dubla marfa pe stoc. Starea se verifică înainte, nu
//     după.
//
//   • CÂT A VENIT NU E CÂT S-A ANUNȚAT. Asta e tot rostul recepției. Dacă
//     formularul vine pre-completat cu cantitatea așteptată și se apasă
//     „ok”, recepția nu verifică nimic — doar semnează. De-aia lipsa se
//     calculează, se arată, și peste un prag cere explicație.
//
//   • MARFA ÎNTOARSĂ NU E MARFĂ NOUĂ. Un retur poate fi spart, murdar sau
//     desfăcut. Nu intră în stocul vandabil până nu spune cineva explicit
//     că e bună; altfel se vinde a doua oară și se întoarce a doua oară.
//
//   • MARFA FĂRĂ LOC E MARFĂ PIERDUTĂ. „E pe undeva prin depozit” nu e un
//     răspuns, și nimeni nu-l dă intenționat — se întâmplă fiindcă nu i s-a
//     cerut nimănui locul la momentul potrivit. Momentul potrivit e ăsta.

const EPS = 0.001;

// „inventar_initial" e marfa care era deja pe rafturi cand a pornit ERP-ul.
// Nu e o cumparare, nu e productie si nu e retur: e o NUMARATOARE. Nimeni
// n-a anuntat nimic dinainte, deci nu exista „cat ar fi trebuit sa vina" —
// si de-aia regula care cere explicatie pentru surplus nu i se aplica. Daca
// i s-ar aplica, omul care incarca stocul de pornire ar trebui sa scrie un
// motiv la fiecare rand, si ar scrie „x" la toate.
const SURSE = ["furnizor", "productie", "retur_tert", "retur_fulfilment", "inventar_initial"];
const STARI = ["asteptata", "in_lucru", "finalizata", "anulata"];
const STARI_LINIE = ["de_primit", "primita", "respinsa"];
// Starea fizică a mărfii la retur. „bun” e singura care intră în stocul
// vandabil — restul intră pe o gestiune separată sau se refuză.
const CONDITII = ["bun", "deteriorat", "desfacut", "lipsa"];

function nr(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

// Câmpul gol nu e zero. „N-am scris nimic încă” și „au venit zero bucăți”
// sunt două lucruri diferite: primul se completează, al doilea e o lipsă
// totală care trebuie explicată.
function cifra(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const x = Number(s);
  return isFinite(x) ? x : null;
}

function esteRetur(sursa) {
  return sursa === "retur_tert" || sursa === "retur_fulfilment";
}

// Cât de mult poate să lipsească fără explicație. Sub pragul ăsta e
// rotunjire de cântar; peste, e ceva de spus.
const TOLERANTA_PROCENT = 2;

// Validarea unui rând de recepție.
//
// linie: { id, cantitate_asteptata, um, denumire }
// scris: { cantitate_primita, loc_id, lot, conditie, motiv }
// optiuni: { sursa, cereLoc }
function validareLinie(linie, scris, optiuni) {
  const l = linie || {};
  const s = scris || {};
  const o = optiuni || {};
  const asteptata = nr(l.cantitate_asteptata);
  const primita = cifra(s.cantitate_primita);

  if (primita === null) {
    return { eroare: "Scrie cât ai primit. Dacă n-a venit nimic, scrie 0 — nu lăsa gol." };
  }
  if (primita < 0) return { eroare: "Cantitatea primită nu poate fi negativă." };

  // Mai mult decât s-a anunțat se poate întâmpla (furnizorul a trimis în
  // plus), dar nu în tăcere: cineva trebuie să știe că are pe stoc marfă pe
  // care n-a comandat-o și pentru care va primi factură. La stocul inițial
  // regula n-are sens: acolo se numără, nu se verifică o livrare.
  // „asteptata > 0" lipsea din conditia asta, si era o gaura: un rand adaugat
  // de mana pe o receptie de la furnizor, cu 0 anuntat, trecea cu orice
  // cantitate fara sa spuna nimeni nimic — adica exact cazul pentru care
  // exista regula. Marfa complet neanuntata e cea mai suspecta, nu cea mai
  // putin.
  if (o.sursa !== "inventar_initial" && primita > asteptata + EPS && !String(s.motiv || "").trim()) {
    return {
      eroare:
        asteptata > EPS
          ? "Ai primit " + primita + ", dar s-au anunțat " + asteptata +
            ". Scrie de ce e mai mult — altfel apare pe stoc marfă necomandată."
          : "Rândul ăsta n-a fost anunțat deloc, iar tu ai primit " + primita +
            ". Scrie de unde vine — altfel apare pe stoc marfă pentru care nimeni nu știe ce factură vine.",
    };
  }

  const lipsa = Math.max(0, Math.round((asteptata - primita) * 1000) / 1000);
  const pragul = asteptata > EPS ? (asteptata * TOLERANTA_PROCENT) / 100 : 0;
  // La stocul initial nu exista „lipsa": nu s-a anuntat nimic de la care sa
  // lipseasca ceva. Se numara ce e pe raft si atat.
  const lipsaReala = o.sursa !== "inventar_initial" && lipsa > pragul + EPS;

  if (lipsaReala && !String(s.motiv || "").trim()) {
    const cuvant =
      o.sursa === "furnizor"
        ? "Lipsesc " + lipsa + ". Scrie ce s-a întâmplat — pe asta se face reclamația la furnizor."
        : o.sursa === "productie"
          ? "Lipsesc " + lipsa + " față de cât a anunțat producția. Scrie de ce — altfel pierderea nu se vede nicăieri."
          : "Lipsesc " + lipsa + " față de cât s-a anunțat. Scrie de ce.";
    return { eroare: cuvant };
  }

  // Marfa întoarsă poate fi stricată. Dacă nu spune nimeni ce stare are,
  // intră în stocul vandabil și se vinde a doua oară.
  let conditie = String(s.conditie || "").trim() || null;
  if (esteRetur(o.sursa)) {
    if (!conditie) {
      return { eroare: "Spune în ce stare a venit marfa înapoi. Un retur necontrolat se vinde a doua oară." };
    }
    if (!CONDITII.includes(conditie)) return { eroare: "Stare necunoscută: " + conditie + "." };
  } else if (conditie && !CONDITII.includes(conditie)) {
    return { eroare: "Stare necunoscută: " + conditie + "." };
  }
  if (!esteRetur(o.sursa) && !conditie) conditie = "bun";

  // Numai marfa bună intră pe stocul din care se vinde.
  const vandabila = conditie === "bun";

  // Un loc e obligatoriu pentru marfa care chiar intră în depozit. Pentru
  // zero bucăți sau pentru marfă respinsă n-are ce să se pună nicăieri.
  const locId = parseInt(s.loc_id, 10) || null;
  if (o.cereLoc && primita > EPS && vandabila && !locId) {
    return { eroare: "Alege locul unde pui marfa. „Pe undeva prin depozit” nu e un răspuns peste două săptămâni." };
  }

  return {
    cantitate_primita: primita,
    lipsa,
    lipsa_reala: lipsaReala,
    in_plus: Math.max(0, Math.round((primita - asteptata) * 1000) / 1000),
    conditie,
    vandabila,
    loc_id: locId,
    lot: String(s.lot || "").trim().slice(0, 60) || null,
    motiv: String(s.motiv || "").trim().slice(0, 300) || null,
    stare: primita > EPS ? "primita" : "respinsa",
  };
}

// Se poate închide recepția?
//
// linii: [{ stare, cantitate_primita, cantitate_asteptata }]
function validareFinalizare(receptie, linii) {
  const r = receptie || {};
  const l = linii || [];

  // Asta e linia care apără stocul. Un buton apăsat de două ori, un refresh
  // pe POST, două tab-uri deschise — oricare ar scrie mișcările de stoc încă
  // o dată, iar marfa s-ar dubla fără ca nimeni să caute vinovatul în
  // recepție.
  if (r.stare === "finalizata") {
    return { eroare: "Recepția e deja finalizată. Stocul s-a scris o dată; a doua oară l-ar dubla." };
  }
  if (r.stare === "anulata") return { eroare: "Recepția e anulată." };
  if (!l.length) return { eroare: "Recepția n-are niciun rând." };

  const neatinse = l.filter((x) => String(x.stare || "de_primit") === "de_primit");
  if (neatinse.length) {
    return {
      eroare:
        neatinse.length === 1
          ? "Mai e un rând la care n-ai scris cât a venit."
          : "Mai sunt " + neatinse.length + " rânduri la care n-ai scris cât a venit.",
    };
  }

  const deIntrat = l.filter((x) => nr(x.cantitate_primita) > EPS);
  const respinse = l.filter((x) => String(x.stare) === "respinsa");
  const lipsuri = l.filter((x) => nr(x.cantitate_asteptata) - nr(x.cantitate_primita) > EPS);
  const nevandabile = deIntrat.filter((x) => x.conditie && x.conditie !== "bun");

  return {
    deIntrat,
    respinse,
    lipsuri,
    nevandabile,
    // Totalul care chiar ajunge pe stocul din care se vinde.
    cantitateVandabila:
      Math.round(
        deIntrat
          .filter((x) => !x.conditie || x.conditie === "bun")
          .reduce((s, x) => s + nr(x.cantitate_primita), 0) * 1000
      ) / 1000,
  };
}

// Rezumatul care se arată pe listă și pe fișa recepției.
function rezumat(linii) {
  const l = linii || [];
  const total = l.length;
  const gata = l.filter((x) => String(x.stare || "de_primit") !== "de_primit").length;
  const cuLipsa = l.filter((x) => nr(x.cantitate_asteptata) - nr(x.cantitate_primita) > EPS).length;
  const stricate = l.filter((x) => x.conditie && x.conditie !== "bun").length;
  return {
    total,
    gata,
    ramase: total - gata,
    cuLipsa,
    stricate,
    procent: total ? Math.round((gata / total) * 100) : 0,
  };
}

module.exports = {
  EPS,
  SURSE,
  STARI,
  STARI_LINIE,
  CONDITII,
  TOLERANTA_PROCENT,
  cifra,
  esteRetur,
  validareLinie,
  validareFinalizare,
  rezumat,
};
