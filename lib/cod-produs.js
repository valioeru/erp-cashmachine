"use strict";
// Codul unic al produsului, născut din caracteristicile lui.
//
// DE CE EXISTĂ. Până acum codul se scria de mână. Două persoane scriau același
// produs în două feluri, iar produsul intra a doua oară în nomenclator cu alt
// cod — și de atunci stocul lui e în două locuri, prețul în două locuri, și
// nimeni nu mai știe care e adevărat. Cererea lui Vali, 26.10.2026: codul se
// generează din caracteristici, iar la produs nou sistemul verifică singur
// dacă mai există.
//
// CUM. Caracteristicile se definesc în Configurări, nu în cod: el adaugă
// „Culoare" cu valorile transparent/alb/negru, fiecare cu bucata ei de cod,
// bifează care intră în cod și în ce ordine. Din
//   Folie Stretch · Manuală · Albă · 10 microni · 200 m
// iese FSMA10200.
//
// REGULA CARE NU SE VEDE PÂNĂ NU DOARE. Bucățile se lipesc una de alta, fără
// separator. Asta face codul scurt, dar și ambiguu dacă numerele au lungimi
// diferite: grosime 1 + lungime 0200 dă același „10200" ca grosime 10 +
// lungime 200. De-aia fiecare caracteristică numerică are un număr de cifre
// fix, completat cu zerouri la stânga. Dacă cineva îl lasă pe zero, codul se
// scrie cum e scris numărul — și funcția spune, explicit, că s-ar putea
// suprapune cu altul.

// Fara diacritice, doar litere si cifre, majuscule. Bucatile de cod se scriu
// de om; „Alb." si „alb" trebuie sa dea acelasi lucru.
function curat(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Textul liber (furnizor, denumire…), cum se scrie pe produs: fără spații la
// capete și fără spații duble. „WBV  GmbH " și „WBV GmbH" sunt același lucru.
function textCurat(v) {
  return String(v == null ? "" : v).trim().replace(/\s+/g, " ");
}

// Literele din care se ia începutul codului, la textul liber. „S.C." sau „SC"
// din fața numelui de firmă se sare: altfel „SC Delivery Solutions SA" ar da
// „SCD", iar jumătate din furnizorii români ar începe la fel.
function litereText(v) {
  const t = textCurat(v).replace(/^s\.?\s*c\.?\s+(?=\S)/i, "");
  return curat(t);
}

// Câte litere din textul liber intră în cod. Vali, 05.11.2026: „primele 2-3
// litere". Se scrie în aceeași coloană ca cifrele numerelor (`cifre`); gol
// înseamnă 3.
function literePentru(c) {
  const n = Math.floor(Number(c && c.cifre) || 0);
  return n >= 1 ? Math.min(n, 6) : 3;
}

// Numărul de ordine de la capătul codului, când categoria are text liber.
// Primele litere ale unui furnizor nu sunt unice („WBV GmbH" și „WBV Pack"
// dau amândouă WBV), deci produsul nu se recunoaște după cod, ci după tot ce
// s-a scris (vezi `semnatura`), iar codul primește un număr: WBVFOL01,
// WBVFOL02…
const CIFRE_CONTOR = 2;

function numar(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

// Numarul, scris pentru cod: fara zecimale inutile, completat cu zerouri la
// stanga pana la cate cifre s-au cerut.
function numarInCod(v, cifre) {
  const n = numar(v);
  if (n === null) return null;
  let s = String(Math.round(n * 1000) / 1000);
  if (s.includes(".")) s = s.replace(".", "");
  s = s.replace(/^-/, "");
  const c = Math.max(0, Math.floor(Number(cifre) || 0));
  return c > 0 ? s.padStart(c, "0") : s;
}

// O caracteristica: { id, nume, fel: "lista"|"numar"|"text", um, in_cod, ordine,
//                     obligatoriu, cifre, min_val, max_val,
//                     valori: [{ valoare, cod }] }
// Alegerile: { <id caracteristicii>: "<valoare>" }
//
// La o categorie cu text liber (fel „text"), `cod` e doar începutul codului
// (`prefix`), iar `contor: true` spune că numărul de ordine se pune la
// salvare, după ce se știe ce numere sunt deja luate. Produsul existent se
// caută după `semnatura` — toate valorile completate, nu primele litere.
function genereazaCod(caracteristici, alegeri) {
  const lista = (caracteristici || [])
    .filter((c) => Number(c.activ === undefined ? 1 : c.activ))
    .slice()
    .sort((a, b) => Number(a.ordine || 0) - Number(b.ordine || 0) || Number(a.id || 0) - Number(b.id || 0));

  const bucati = [];
  const lipsa = [];
  const gresite = [];
  const descriere = [];
  // Tot ce s-a ales, pentru cazul în care nicio caracteristică nu intră în
  // denumire: produsul nu poate rămâne fără nume.
  const toate = [];
  let ambiguu = false;
  // Unitatea de măsură pe care o dă o valoare aleasă (hârtia: „Cutie (5
  // topuri)" → cutie, „Top" → top). Prima găsită, în ordinea
  // caracteristicilor. La restul familiilor rămâne null și contează ce a
  // scris omul în căsuța de UM.
  let um = null;
  // Tot ce s-a completat, câte o pereche „id=valoare", pentru recunoașterea
  // produsului la categoriile cu text liber.
  const semn = [];
  const contor = lista.some((c) => c.fel === "text");

  for (const c of lista) {
    const brut = alegeri ? alegeri[c.id] : undefined;
    // „Intră în denumire" (implicit da). La furnizor e „nu": numele
    // produsului e „Folie aluminiu", nu „WBV GmbH Folie aluminiu".
    const inDen = Number(c.in_denumire === undefined || c.in_denumire === null ? 1 : c.in_denumire);
    const descrie = (t) => { toate.push(t); if (inDen) descriere.push(t); };
    const are = brut !== undefined && brut !== null && String(brut).trim() !== "";

    if (!are) {
      if (Number(c.obligatoriu === undefined ? 1 : c.obligatoriu)) lipsa.push(c.nume);
      continue;
    }

    if (c.fel === "text") {
      const t = textCurat(brut);
      const lit = litereText(t);
      if (!lit) {
        gresite.push(`${c.nume}: „${t}" n-are nicio literă sau cifră din care să iasă codul`);
        continue;
      }
      descrie(t);
      // „S.C. WBV GmbH" și „WBV GmbH" sunt aceeași firmă: se compară ca la cod.
      semn.push([Number(c.id), lit]);
      if (Number(c.in_cod === undefined ? 1 : c.in_cod)) {
        bucati.push({ caracteristica: c.nume, valoare: t, cod: lit.slice(0, literePentru(c)) });
      }
      continue;
    }

    if (c.fel === "numar") {
      const n = numar(brut);
      if (n === null) {
        gresite.push(`${c.nume}: „${brut}" nu e un număr`);
        continue;
      }
      // Intervalul, cand e scris: grosimile merg de la 4 la 23 de microni, si
      // un 230 scris din greseala trebuie prins aici, nu in depozit.
      const jos = numar(c.min_val);
      const sus = numar(c.max_val);
      if (jos !== null && n < jos) gresite.push(`${c.nume}: ${n} e sub minimul de ${jos}`);
      else if (sus !== null && n > sus) gresite.push(`${c.nume}: ${n} e peste maximul de ${sus}`);
      descrie(`${n}${c.um ? " " + c.um : ""}`);
      semn.push([Number(c.id), String(n)]);
      if (Number(c.in_cod === undefined ? 1 : c.in_cod)) {
        const buc = numarInCod(n, c.cifre);
        const c0 = Math.max(0, Math.floor(Number(c.cifre) || 0));
        if (!c0) ambiguu = true;
        // Numarul care nu incape in locul lui.
        //
        // `numarInCod` doar completeaza cu zerouri in fata, nu taie niciodata:
        // o latime de 3500 scrisa in loc de 350, intr-un loc de 3 cifre, iesea
        // pe patru si impingea tot ce urmeaza. Codul rezultat avea alta
        // lungime si nu se mai putea citi inapoi — nimeni n-ar fi observat
        // pana cand cineva cauta produsul dupa cod si nu-l gasea.
        //
        // Majoritatea familiilor n-au min/max scrise, deci asta e singura
        // plasa care prinde un zero in plus tastat din greseala.
        if (c0 && buc && buc.length > c0) {
          gresite.push(`${c.nume}: „${brut}" nu încape în ${c0} ${c0 === 1 ? "cifră" : "cifre"}`);
          continue;
        }
        bucati.push({ caracteristica: c.nume, valoare: String(n), cod: buc });
      }
      continue;
    }

    // Lista: valoarea trebuie sa existe intre cele definite. O valoare
    // nerecunoscuta nu primeste bucata de cod, si atunci codul ar iesi scurt
    // si s-ar lipi peste altul — deci se refuza, nu se sare peste.
    const v = (c.valori || []).find((x) => curat(x.valoare) === curat(brut));
    if (!v) {
      gresite.push(`${c.nume}: „${brut}" nu e între valorile definite`);
      continue;
    }
    descrie(String(v.valoare));
    semn.push([Number(c.id), curat(v.valoare)]);
    if (!um && v.um != null && String(v.um).trim()) um = String(v.um).trim();
    if (Number(c.in_cod === undefined ? 1 : c.in_cod)) {
      // Bucata poate fi goală — „Nepersonalizată" la bandă (vezi
      // lib/cod-familii.js): valoarea e aleasă, dar codul rămâne cel de
      // dinainte să existe caracteristica.
      bucati.push({ caracteristica: c.nume, valoare: v.valoare, cod: curat(v.cod) });
    }
  }

  const cod = bucati.map((b) => b.cod).join("");
  return {
    cod,
    bucati,
    lipsa,
    gresite,
    // Cu număr de ordine la capăt, lungimile textului nu mai pot face două
    // produse cu același cod — deci nu se mai avertizează pentru numere.
    ambiguu: !contor && ambiguu && bucati.length > 1,
    denumire: (descriere.length ? descriere : toate).join(" "),
    um,
    contor,
    prefix: contor ? cod : null,
    // Ordinea după id, nu după ordinea din cod: dacă cineva mută
    // caracteristicile, produsele vechi trebuie recunoscute în continuare.
    semnatura: contor ? semn.sort((a, b) => a[0] - b[0]).map(([id, v]) => id + "=" + v).join("|") : null,
    ok: lipsa.length === 0 && gresite.length === 0 && cod.length > 0,
  };
}

// Codul final la o categorie cu text liber: începutul + primul număr de ordine
// liber. `luate` = codurile deja folosite care încep cu prefixul.
function codCuContor(prefix, luate) {
  const p = String(prefix || "");
  const folosite = new Set((luate || []).map((x) => String(x || "").trim().toUpperCase()));
  const re = new RegExp("^" + p + "(\\d{" + CIFRE_CONTOR + ",})$");
  let max = 0;
  for (const x of folosite) {
    const m = x.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (folosite.has(p + String(n).padStart(CIFRE_CONTOR, "0"))) n++;
  return p + String(n).padStart(CIFRE_CONTOR, "0");
}

// Caracteristicile care intra in cod, in ordinea lor — pentru ecranul de
// configurare si pentru explicatia de sub codul generat.
function sablon(caracteristici) {
  const active = (caracteristici || []).filter((c) => Number(c.activ === undefined ? 1 : c.activ));
  const parti = active
    .filter((c) => Number(c.in_cod === undefined ? 1 : c.in_cod))
    .slice()
    .sort((a, b) => Number(a.ordine || 0) - Number(b.ordine || 0) || Number(a.id || 0) - Number(b.id || 0))
    .map((c) => ({
      nume: c.nume,
      exemplu:
        c.fel === "text"
          ? "ABCDEF".slice(0, literePentru(c))
          : c.fel === "numar"
            ? numarInCod(c.max_val != null && c.max_val !== "" ? c.max_val : 10, c.cifre) || "10"
            : // Prima valoare care chiar pune ceva în cod: „Nepersonalizată" nu
              // pune nimic, iar exemplul ar fi ieșit cu „?" în coadă.
              curat(((c.valori || []).find((v) => curat(v.cod)) || {}).cod) || "?",
    }));
  if (parti.length && active.some((c) => c.fel === "text")) {
    parti.push({ nume: "nr. de ordine", exemplu: "1".padStart(CIFRE_CONTOR, "0") });
  }
  return parti;
}

module.exports = { genereazaCod, sablon, curat, numarInCod, textCurat, litereText, literePentru, codCuContor, CIFRE_CONTOR };
