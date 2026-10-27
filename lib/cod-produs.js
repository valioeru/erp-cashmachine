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

// O caracteristica: { id, nume, fel: "lista"|"numar", um, in_cod, ordine,
//                     obligatoriu, cifre, min_val, max_val,
//                     valori: [{ valoare, cod }] }
// Alegerile: { <id caracteristicii>: "<valoare>" }
function genereazaCod(caracteristici, alegeri) {
  const lista = (caracteristici || [])
    .filter((c) => Number(c.activ === undefined ? 1 : c.activ))
    .slice()
    .sort((a, b) => Number(a.ordine || 0) - Number(b.ordine || 0) || Number(a.id || 0) - Number(b.id || 0));

  const bucati = [];
  const lipsa = [];
  const gresite = [];
  const descriere = [];
  let ambiguu = false;

  for (const c of lista) {
    const brut = alegeri ? alegeri[c.id] : undefined;
    const are = brut !== undefined && brut !== null && String(brut).trim() !== "";

    if (!are) {
      if (Number(c.obligatoriu === undefined ? 1 : c.obligatoriu)) lipsa.push(c.nume);
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
      descriere.push(`${n}${c.um ? " " + c.um : ""}`);
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
    descriere.push(String(v.valoare));
    if (Number(c.in_cod === undefined ? 1 : c.in_cod)) {
      bucati.push({ caracteristica: c.nume, valoare: v.valoare, cod: curat(v.cod) });
    }
  }

  const cod = bucati.map((b) => b.cod).join("");
  return {
    cod,
    bucati,
    lipsa,
    gresite,
    ambiguu: ambiguu && bucati.length > 1,
    denumire: descriere.join(" "),
    ok: lipsa.length === 0 && gresite.length === 0 && cod.length > 0,
  };
}

// Caracteristicile care intra in cod, in ordinea lor — pentru ecranul de
// configurare si pentru explicatia de sub codul generat.
function sablon(caracteristici) {
  return (caracteristici || [])
    .filter((c) => Number(c.activ === undefined ? 1 : c.activ) && Number(c.in_cod === undefined ? 1 : c.in_cod))
    .slice()
    .sort((a, b) => Number(a.ordine || 0) - Number(b.ordine || 0) || Number(a.id || 0) - Number(b.id || 0))
    .map((c) => ({
      nume: c.nume,
      exemplu:
        c.fel === "numar"
          ? numarInCod(c.max_val != null && c.max_val !== "" ? c.max_val : 10, c.cifre) || "10"
          : curat(((c.valori || [])[0] || {}).cod) || "?",
    }));
}

module.exports = { genereazaCod, sablon, curat, numarInCod };
