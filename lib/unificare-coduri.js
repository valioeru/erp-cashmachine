"use strict";
// Unificarea codurilor de produs — socoteala, fără bază de date.
//
// CEREREA LUI VALI, 17.11.2026:
//   „Vreau să găsim o soluție să folosim aceleași coduri pentru produse; acum
//    sunt aceleași produse cu diverse coduri. Propun o pagină de configurare
//    unde să asociezi tu, la produsele cu coduri noi, toate produsele cu stoc
//    care ți se par similare, iar odată ce noi validăm să ștergi produsul vechi
//    și să muți stocul pe noul produs, cu modificare peste tot în depozit etc.
//    Toate produsele vechi fără stoc să le marcăm (să apară, dar să fie marcate
//    ca produs cu cod vechi, nu selecta); ulterior, dacă nu mai sunt folosite o
//    lună de zile, le parchezi undeva și nici nu le mai sugerezi."
//
// CE E ÎN NOMENCLATOR (măsurat pe 17.11.2026: 4.280 de produse active):
//
//   • Produse cu COD NOU: făcute din configurator, cu familie
//     (`cod_familie_id`) — FSVAT2316T, CC03400360200.
//   • Produse cu COD VECHI: tot restul. Printre ele, 592 sunt scrise de două
//     ori: o dată „Denumire (COD)", fără cod, și o dată „Denumire", cu codul în
//     câmpul lui. La 15 din perechile astea stocul stă pe cel fără cod sau e
//     împărțit între cele două (banda Fragil 50X60: 684 buc pe cel vechi).
//
// DOUĂ FELURI DE POTRIVIRE:
//
//   1. „Scris de două ori" (`perechi`): produsul fără cod al cărui nume se
//      termină cu „(COD)" și cel care are chiar codul ăla. Dacă și denumirea e
//      aceeași, perechea e SIGURĂ; dacă doar codul, e de privit.
//   2. „Seamănă" (`asemanare`): un produs vechi și unul cu cod nou care par
//      aceeași marfă după cuvinte și, mai ales, după numere. Pe 17.11.2026,
//      „TUB SP 470 50/62 350 gr" și „SP 470 50/63 350 gr" n-aveau niciun cuvânt
//      lung în comun și erau aceeași marfă: numerele spun ce produs e. Ce se
//      contrazice (felul mărfii, culoarea, virgin/reciclat, manual/automat,
//      grosimea, măsurile scrise cu „x") e altă marfă, oricâte cuvinte ar avea
//      în comun.
//
// Nimic de aici nu unifică. Pagina (modules/unificare-coduri.js) propune, omul
// validează, iar mutarea o face motorul vechi (lib/produse-fuziune.js).

const faraSemne = (t) =>
  String(t == null ? "" : t)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

// Cheia de comparat: litere și cifre, despărțite de câte un spațiu.
const cheie = (t) => faraSemne(t).replace(/[^a-z0-9]+/g, " ").trim();

// Produsul cu cod nou: făcut din configurator.
const eNou = (p) => Number(p && p.cod_familie_id) > 0;

// „Denumire (COD)" → { nume, cod }. Paranteza de la coadă, cu tot cu cele din
// ea („SHEETS NE1N (NE1N ( 2000 x 1500 ))"). Fără paranteză la coadă: null.
function coadaCuCod(denumire) {
  const t = String(denumire == null ? "" : denumire).trim();
  if (!t.endsWith(")")) return null;
  let ad = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ")") ad++;
    else if (t[i] === "(") {
      ad--;
      if (ad === 0) {
        const nume = t.slice(0, i).trim();
        const cod = t.slice(i + 1, -1).trim();
        return nume && cod && cod.length <= 60 ? { nume, cod } : null;
      }
    }
  }
  return null;
}

// Perechile „scris de două ori". `produse`: cele active și neunificate, cu
// { id, cod, denumire, cod_familie_id }. Întoarce, pentru fiecare produs fără
// cod cu „(COD)" la coadă care are un frate cu codul ăla:
//   { vechi, nou, sigura, altele }
// `sigura` = și denumirea e aceeași; `altele` = câți alți frați cu același cod
// mai sunt (atunci omul trebuie să se uite). Dintre mai mulți frați se alege
// cel cu aceeași denumire, apoi cel cu cod nou, apoi cel mai vechi (id mic).
function perechi(produse) {
  const dupaCod = new Map();
  for (const p of produse || []) {
    const k = cheie(p.cod);
    if (!k) continue;
    if (!dupaCod.has(k)) dupaCod.set(k, []);
    dupaCod.get(k).push(p);
  }
  const out = [];
  for (const v of produse || []) {
    if (cheie(v.cod)) continue;
    const c = coadaCuCod(v.denumire);
    if (!c) continue;
    const frati = (dupaCod.get(cheie(c.cod)) || []).filter((x) => Number(x.id) !== Number(v.id));
    if (!frati.length) continue;
    const numeV = cheie(c.nume);
    const cuRang = frati
      .map((x) => ({ x, laFel: cheie(x.denumire) === numeV }))
      .sort((a, b) => Number(b.laFel) - Number(a.laFel) || Number(eNou(b.x)) - Number(eNou(a.x)) || Number(a.x.id) - Number(b.x.id));
    out.push({ vechi: v, nou: cuRang[0].x, sigura: cuRang[0].laFel, altele: frati.length - 1 });
  }
  return out;
}

// ---- asemănarea -----------------------------------------------------------

// Cuvinte care nu spun ce marfă e.
const OPRITE = new Set(
  "cu de la din pe si sau pentru buc bucata bucati rola role rol kg mm cm my mic micron microni net brut tip the with per pcs roll rolls set ml gr coli top".split(" ")
);
// Același lucru scris altfel. Cheia e cuvântul fără diacritice.
const SINONIME = {
  benzi: "banda", tape: "banda", scotch: "banda",
  adeziva: "adeziv", adezive: "adeziv", adhesive: "adeziv",
  pungi: "punga", saci: "sac", sacii: "sac", cutii: "cutie", box: "cutie", plicuri: "plic", plicul: "plic",
  folii: "folie", film: "folie", tuburi: "tub", placi: "placa", sheets: "placa", granule: "granula",
  etichete: "eticheta", labels: "eticheta", label: "eticheta", hartii: "hartie", paper: "hartie",
  automata: "automat", manuala: "manual", manuale: "manual",
  transparenta: "transparent", transp: "transparent", neagra: "negru", black: "negru", alba: "alb", white: "alb",
  brown: "maro", albastra: "albastru", blue: "albastru", green: "verde", rosie: "rosu", red: "rosu", galbena: "galben", yellow: "galben",
  reciclata: "reciclat", recycled: "reciclat", regranulat: "reciclat",
  acryl: "acrilic", acrylic: "acrilic", acrilica: "acrilic",
};
const CULORI = ["transparent", "alb", "negru", "maro", "albastru", "verde", "rosu", "galben", "natur"];
// Felul mărfii, după cuvântul care îl spune. Ordinea contează: „folie cu bule"
// e folie cu bule, nu folie stretch; „pungă curier LDPE" e pungă, nu granulă.
const FELURI = [
  ["bule", ["bule"]],
  ["banda", ["banda"]],
  ["punga", ["punga"]],
  ["sac", ["sac"]],
  ["plic", ["plic"]],
  ["cutie", ["cutie"]],
  ["placa", ["placa"]],
  ["hartie", ["hartie", "copiator"]],
  ["tub", ["tub"]],
  ["eticheta", ["eticheta"]],
  ["folie", ["folie", "stretch", "jumbo", "prestretch"]],
  ["granula", ["granula", "ldpe", "hdpe", "lldpe", "masterbatch", "masterbatches"]],
];

const GROSIME = /(\d{1,3})\s*(?:my|µm?|microni|micron|mic)(?![a-z])/;
const MASURI = /(\d{2,4})\s*(?:mm|cm|m)?\s*[x*×]\s*(\d{2,4})(?:\s*(?:mm|cm|m)?\s*[x*×]\s*(\d{2,4}))?/g;
// Un număr, cu unitatea lui lipită sau nu, care nu e bucată dintr-un cod.
const NUMAR = /(?<![a-z0-9.,])(\d+(?:[.,]\d+)?)(?:\s?(?:mm|cm|m|my|mic|microni|micron|kg|g|gr|ml|l))?(?![a-z0-9])/g;

// Ce se poate citi dintr-o denumire (și, la nevoie, din cod).
function trasaturi(denumire, cod) {
  // Codul ajută doar când spune ceva („SSA23/16/2000", „NegruCM"). Unul făcut
  // numai din cifre („1056", „7441399") e un număr de ordine, nu o măsură.
  const codUtil = /[a-z]/i.test(String(cod == null ? "" : cod)) ? cod : "";
  const brut = faraSemne(`${denumire == null ? "" : denumire} ${codUtil}`);
  // Măsurile scrise cu „x", „*" sau „/" devin numere despărțite.
  const t = brut.replace(/(\d)\s*(?:mm|cm|m)?\s*[x*×/]\s*(?=\d)/g, "$1 ");
  const numere = new Set();
  for (const m of t.matchAll(NUMAR)) {
    const n = Number(m[1].replace(",", "."));
    if (Number.isFinite(n) && n > 0) numere.add(String(n));
  }
  const cuvinte = new Set();
  const culori = new Set();
  for (const brutCuvant of t.split(/[^a-z0-9]+/)) {
    if (!brutCuvant || /^\d+$/.test(brutCuvant)) continue;
    const w = SINONIME[brutCuvant] || brutCuvant;
    // Codurile vechi lipesc culoarea de restul: „JLP23NEGRUPF", „NegruCM".
    for (const c of CULORI) if (w === c || (w.length > c.length + 1 && c.length >= 4 && w.includes(c))) culori.add(c);
    if (w === "tr") culori.add("transparent");
    // Bucățile de cod („jlp23negrupf") nu sunt cuvinte de comparat, dar numărul din ele e.
    if (/\d/.test(w)) {
      for (const m of w.matchAll(/(?<![0-9])(\d{2,4})(?![0-9])/g)) if (/[a-z]/.test(w) && w.length <= 14) numere.add(String(Number(m[1])));
      continue;
    }
    if (w.length < 3 || OPRITE.has(w)) continue;
    cuvinte.add(w);
  }
  let fel = null;
  for (const [nume, semne] of FELURI) {
    if (semne.some((s) => cuvinte.has(s))) {
      fel = nume;
      break;
    }
  }
  const g = GROSIME.exec(brut);
  return {
    cuvinte,
    numere,
    culori,
    fel,
    material: cuvinte.has("reciclat") ? "reciclat" : cuvinte.has("virgin") ? "virgin" : null,
    aplicare: cuvinte.has("manual") && !cuvinte.has("automat") ? "manual" : cuvinte.has("automat") && !cuvinte.has("manual") ? "automat" : null,
    grosime: g ? Number(g[1]) : null,
    masuri: [...brut.matchAll(MASURI)].map((m) => [m[1], m[2], m[3]].filter(Boolean).map(Number).join("x")),
  };
}

// Două măsuri sunt aceeași marfă și când una e scrisă mai scurt sau în altă
// ordine: „520x50" încape în „50x57x520". Se contrazic doar când niciuna nu
// încape în cealaltă (48x60 și 50x60).
function masuriCareSeIncap(m, n) {
  const a = m.split("x");
  const b = n.split("x");
  return a.every((x) => b.includes(x)) || b.every((x) => a.includes(x));
}

const comune = (a, b) => [...a].filter((x) => b.has(x));
const reunite = (a, b) => new Set([...a, ...b]).size;

// Trăsăturile unui produs se citesc o singură dată: pagina compară fiecare
// produs vechi cu toate cele cu cod nou, iar cititul e partea scumpă. Produsul
// vechi se citește cu tot cu cod („SSA23/16/2000" spune măsurile), cel cu cod
// nou doar din denumire (codul lui e făcut din ea), deci țin două socoteli.
const cititeCuCod = new WeakMap();
const cititeFaraCod = new WeakMap();
function trasaturileLui(p, cuCod) {
  if (!p || typeof p !== "object") return trasaturi(null, null);
  const citite = cuCod ? cititeCuCod : cititeFaraCod;
  let t = citite.get(p);
  if (!t) {
    t = trasaturi(p.denumire, cuCod ? p.cod : null);
    citite.set(p, t);
  }
  return t;
}

// Cât seamănă un produs vechi cu unul cu cod nou. Întoarce
//   { scor: 0…1, motive: [texte scurte], contra: null | ce se contrazice }
// Scorul pune numerele înaintea cuvintelor: 60% numerele comune din toate
// numerele celor două, 40% cuvintele. Fără niciun număr de o parte sau de
// alta, rămân doar cuvintele, cu scorul tăiat (nu se poate ști măsura).
function asemanare(vechi, nou) {
  const a = trasaturileLui(vechi, true);
  const b = trasaturileLui(nou, false);
  const contra =
    a.fel && b.fel && a.fel !== b.fel
      ? `altă marfă (${a.fel} / ${b.fel})`
      : a.culori.size && b.culori.size && !comune(a.culori, b.culori).length
        ? `altă culoare (${[...a.culori].join(", ")} / ${[...b.culori].join(", ")})`
        : a.material && b.material && a.material !== b.material
          ? `${a.material} / ${b.material}`
          : a.aplicare && b.aplicare && a.aplicare !== b.aplicare
            ? `${a.aplicare} / ${b.aplicare}`
            : a.grosime != null && b.grosime != null && a.grosime !== b.grosime
              ? `altă grosime (${a.grosime} / ${b.grosime})`
              : a.masuri.length && b.masuri.length && !a.masuri.some((m) => b.masuri.some((n) => masuriCareSeIncap(m, n)))
                ? `alte măsuri (${a.masuri.join(", ")} / ${b.masuri.join(", ")})`
                : null;
  if (contra) return { scor: 0, motive: [], contra };
  const nC = comune(a.numere, b.numere);
  const cC = comune(a.cuvinte, b.cuvinte);
  const totN = reunite(a.numere, b.numere);
  const totC = reunite(a.cuvinte, b.cuvinte);
  const jN = totN ? nC.length / totN : null;
  const jC = totC ? cC.length / totC : 0;
  let scor;
  if (!a.numere.size && !b.numere.size) scor = jC * 0.8;
  // O denumire făcută doar din numere („SP 470 50/63 350 gr") n-are cuvinte de
  // comparat: rămân numerele, cu scorul puțin tăiat.
  else if (!a.cuvinte.size || !b.cuvinte.size) scor = (jN || 0) * 0.9;
  else scor = 0.6 * (jN || 0) + 0.4 * jC;
  const motive = [];
  if (nC.length) motive.push(`numere comune: ${nC.sort((x, y) => Number(x) - Number(y)).join(", ")}`);
  if (cC.length) motive.push(`cuvinte comune: ${cC.slice(0, 6).join(", ")}`);
  return { scor: Math.round(scor * 100) / 100, motive, contra: null };
}

const PRAG = 0.4; // sub el nu se propune nimic
const PRAG_BUN = 0.7; // de aici în sus potrivirea e „mare"

// Cele mai bune potriviri ale unui produs vechi printre cele cu cod nou.
// `respinse`: Set cu „idVechi:idNou" hotărâte de om ca fiind alt produs.
function propuneri(vechi, noi, respinse, cate) {
  const out = [];
  for (const n of noi || []) {
    if (Number(n.id) === Number(vechi.id)) continue;
    if (respinse && respinse.has(`${vechi.id}:${n.id}`)) continue;
    const s = asemanare(vechi, n);
    if (s.scor >= PRAG) out.push({ nou: n, scor: s.scor, motive: s.motive });
  }
  return out.sort((x, y) => y.scor - x.scor || Number(x.nou.id) - Number(y.nou.id)).slice(0, cate || 3);
}

const cuvantScor = (s) => (s >= PRAG_BUN ? "mare" : s >= 0.55 ? "medie" : "slabă");

module.exports = { faraSemne, cheie, eNou, coadaCuCod, perechi, trasaturi, asemanare, propuneri, cuvantScor, PRAG, PRAG_BUN };
