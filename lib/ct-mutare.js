"use strict";
// Mutarea unui palet dintr-un loc în altul, în CT-Park.
//
// DE CE EXISTĂ. Până acum un palet se putea scoate din depozit și reintroduce
// în altă parte, ceea ce rupe istoria: data intrării se pierde, FIFO o ia de
// la capăt, iar prețul lipit de palet trebuie rescris de mână. Vali: „sa pot
// muta usor marfa de pe un spatiu pe altul [...] alegi pe harta marfa si apoi
// alegi unde sa o muti si validezi". O mutare schimbă DOAR locurile: paletul
// rămâne același, cu aceeași dată, același lot, același preț.
//
// Regula care contează cel mai mult, și pe care a spus-o el însuși:
// „atentie daca ocupa mai multe spatii sa aibe loc in partea aia". Un palet
// lat stă pe locuri LIPITE, în același rând, același nivel, același câmp.
// Nu se poate rupe în două câmpuri și nici nu se poate întinde peste un gol.
// Verificarea asta stă aici, nu în rută, ca să fie aceeași și pentru mutarea
// de pe hartă, și pentru cea scrisă în formular.

const nr = (v) => Number(v || 0);

// Locurile lipite, grupate. Două locuri sunt lipite dacă sunt în același
// rând, nivel și câmp, iar pozițiile lor se succed fără pauză.
function grupeazaLipite(locuri) {
  const l = (locuri || [])
    .slice()
    .sort(
      (a, b) =>
        nr(a.rand_id) - nr(b.rand_id) || nr(a.nivel) - nr(b.nivel) || nr(a.camp) - nr(b.camp) || nr(a.pozitie) - nr(b.pozitie)
    );
  const out = [];
  let curent = [];
  for (const x of l) {
    const u = curent[curent.length - 1];
    const lipit =
      u &&
      nr(u.rand_id) === nr(x.rand_id) &&
      nr(u.nivel) === nr(x.nivel) &&
      nr(u.camp) === nr(x.camp) &&
      nr(x.pozitie) === nr(u.pozitie) + 1;
    if (lipit) curent.push(x);
    else {
      if (curent.length) out.push(curent);
      curent = [x];
    }
  }
  if (curent.length) out.push(curent);
  return out;
}

const adresaLista = (locuri) => (locuri || []).map((l) => l.adresa).join(", ");

// Poate paletul ăsta să se mute pe locurile astea?
//
//   palet   — { id, cod, nume }
//   acum    — locurile pe care stă acum (din ct_ocupari)
//   tinta   — locurile alese, așa cum vin din bază (cu blocat și ocupat_de)
//
// `ocupat_de` e id-ul paletului care stă pe locul ăla, sau null. Locurile
// paletului CARE SE MUTĂ nu sunt o piedică: un palet de trei locuri se poate
// muta cu un loc mai la dreapta, peste două dintre locurile ei de acum.
function validareMutare(palet, acum, tinta) {
  const cateTrebuie = (acum || []).length;
  const nume = (palet && (palet.nume || palet.cod)) || "paletul";

  if (!palet || !palet.id) return { ok: false, motiv: "N-am ce muta: nu știu ce palet." };
  if (!cateTrebuie) return { ok: false, motiv: `${nume} nu stă pe niciun loc acum — n-are de unde fi mutată.` };
  if (!tinta || !tinta.length) return { ok: false, motiv: "Alege unde s-o muți." };

  // Blocate: locuri scoase din uz. Nu se pune marfă pe ele nici din greșeală.
  const blocate = tinta.filter((l) => nr(l.blocat));
  if (blocate.length)
    return { ok: false, motiv: `${adresaLista(blocate)} ${blocate.length === 1 ? "e scos" : "sunt scoase"} din uz.` };

  // Ocupate de ALTCINEVA. Ale paletului care se mută nu contează.
  const ocupate = tinta.filter((l) => l.ocupat_de && Number(l.ocupat_de) !== Number(palet.id));
  if (ocupate.length)
    return {
      ok: false,
      motiv: `Pe ${adresaLista(ocupate)} stă deja altă marfă. Alege alt loc sau scoate-o întâi.`,
    };

  if (tinta.length !== cateTrebuie) {
    // Cazul lui: „daca ocupa mai multe spatii sa aibe loc in partea aia".
    // Mesajul spune câte sunt și câte trebuie, nu doar că nu merge.
    return {
      ok: false,
      motiv:
        tinta.length < cateTrebuie
          ? `${nume} ține ${cateTrebuie} locuri, iar tu ai ales ${tinta.length}. Mai alege ${cateTrebuie - tinta.length}.`
          : `${nume} ține ${cateTrebuie} ${cateTrebuie === 1 ? "loc" : "locuri"}, iar tu ai ales ${tinta.length}. Lasă ${tinta.length - cateTrebuie} deoparte.`,
    };
  }

  // Lipite. Un palet lat nu se rupe în două câmpuri și nu sare peste un gol.
  const grupuri = grupeazaLipite(tinta);
  if (grupuri.length > 1) {
    const unde = grupuri.map((g) => adresaLista(g)).join(" / ");
    return {
      ok: false,
      motiv: `Locurile alese nu sunt lipite: ${unde}. Un palet de ${cateTrebuie} locuri are nevoie de ${cateTrebuie} poziții una lângă alta, în același câmp și nivel.`,
    };
  }

  // Mutare în gol: a ales exact locurile pe care stă deja.
  const aceleasi =
    tinta.length === cateTrebuie &&
    tinta.every((l) => (acum || []).some((a) => Number(a.id) === Number(l.id)));
  if (aceleasi) return { ok: false, motiv: `${nume} e deja acolo.` };

  return { ok: true, locuri: grupuri[0], de_la: adresaLista(acum), unde: adresaLista(grupuri[0]) };
}

// Grupurile de locuri libere lipite, de lungimea cerută, dintr-o listă de
// locuri libere. Folosită ca să PROPUNEM unde încape paletul, nu doar să
// spunem „nu încape" după ce omul a ales prost.
function undeIncape(libere, cate, limita) {
  const out = [];
  for (const g of grupeazaLipite(libere)) {
    for (let i = 0; i + cate <= g.length; i++) out.push(g.slice(i, i + cate));
    if (limita && out.length >= limita) break;
  }
  return limita ? out.slice(0, limita) : out;
}

// Câte locuri ține un palet care stă deja în raft: 1, 2 sau 3, lipite, în
// același câmp și nivel. Vali, 30.10.2026: „vreau să pot modifica o marfă pusă
// inițial să ocupe doar un spațiu, să poată ocupa două sau trei, ca să nu o
// scot și s-o repun" · „extinde la spațiul de lângă, unul sau două".
//
//   palet  — { id, nume }
//   acum   — locurile paletului acum
//   inCamp — toate locurile din același rând, nivel și câmp, cu `blocat` și
//            `ocupat_de` (paletul care stă pe loc, sau null)
//   cate   — câte locuri să țină
//   parte  — "dreapta" | "stanga" | "" — partea care se schimbă. Gol = unde e
//            loc, întâi spre dreapta. La micșorare, gol = se eliberează dreapta.
//
// Ca la mutare, paletul rămâne același: dată, lot, preț. Se schimbă doar
// locurile, deci nu trebuie scos și repus.
const LATIME_MAX = 3;
function planLatime(palet, acum, inCamp, cate, parte) {
  const nume = (palet && (palet.nume || palet.cod)) || "Paletul";
  const k = Math.round(nr(cate));
  const n = (acum || []).length;
  if (!n) return { ok: false, motiv: `${nume} nu stă pe niciun loc.` };
  if (k < 1 || k > LATIME_MAX) return { ok: false, motiv: `Un palet ține 1, 2 sau ${LATIME_MAX} locuri.` };
  const grupuri = grupeazaLipite(acum);
  if (grupuri.length > 1) return { ok: false, motiv: `Locurile lui ${nume} nu sunt lipite — mută-l întâi pe locuri una lângă alta.` };
  if (k === n) return { ok: false, motiv: `${nume} ține deja ${n} ${n === 1 ? "loc" : "locuri"}.` };
  const sir = grupuri[0];

  if (k < n) {
    const pastrate = parte === "stanga" ? sir.slice(n - k) : sir.slice(0, k);
    const scoase = sir.filter((l) => !pastrate.includes(l));
    return { ok: true, locuri: pastrate, adaugate: [], scoase };
  }

  const pePoz = new Map((inCamp || []).map((l) => [nr(l.pozitie), l]));
  const lo = nr(sir[0].pozitie);
  const hi = nr(sir[sir.length - 1].pozitie);
  // Ferestrele de k poziții care cuprind locurile de acum, în ordinea
  // preferinței: întâi spre dreapta, apoi tot mai spre stânga.
  let starturi = [];
  for (let s = lo; s >= hi - k + 1; s--) starturi.push(s);
  if (parte === "dreapta") starturi = [lo];
  if (parte === "stanga") starturi = [hi - k + 1];
  const motive = [];
  for (const s of starturi) {
    const locuri = [];
    const piedici = [];
    for (let p = s; p < s + k; p++) {
      const l = pePoz.get(p);
      if (!l) piedici.push(`câmpul n-are poziția ${p}`);
      else if (nr(l.blocat)) piedici.push(`${l.adresa} e scos din uz`);
      else if (l.ocupat_de && Number(l.ocupat_de) !== Number(palet && palet.id)) piedici.push(`pe ${l.adresa} stă altă marfă`);
      else locuri.push(l);
    }
    if (!piedici.length) {
      const adaugate = locuri.filter((l) => !sir.some((a) => Number(a.id) === Number(l.id)));
      return { ok: true, locuri, adaugate, scoase: [] };
    }
    for (const m of piedici) if (!motive.includes(m)) motive.push(m);
  }
  const unde = parte === "dreapta" ? " în dreapta" : parte === "stanga" ? " în stânga" : "";
  return { ok: false, motiv: `Nu e loc${unde} pentru ${k} locuri: ${motive.join("; ")}.` };
}

module.exports = { grupeazaLipite, validareMutare, undeIncape, planLatime, LATIME_MAX };
