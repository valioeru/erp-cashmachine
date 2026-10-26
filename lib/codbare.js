"use strict";
// Coduri de bare Code 128-B, desenate ca SVG direct in pagina.
//
// De ce aici si nu o biblioteca: fisa insotitoare de lot se tipareste dintr-un
// browser, pe hartie, in hala. Daca imaginea codului ar veni de pe un CDN,
// prima zi fara internet in birou ar scoate o fisa cu patrate goale in loc de
// coduri — si nimeni n-ar mai putea scana nimic la post. Un SVG scris in
// pagina se tipareste si cand nu merge nimic altceva.
//
// De ce Code 128-B si nu altceva: scannerele ieftine de hala il citesc toate,
// accepta litere mari, cifre si semne (CMP142.030), si nu cere cifra de
// control calculata de om — o pune codul. Nu folosim Code 128-C (doar cifre,
// perechi) fiindca ar lungi codul lotului, si nici QR, fiindca scannerele
// liniare din hala nu-l vad.
//
// Latimile celor 107 simboluri. Fiecare sir are 6 cifre — latimile benzilor
// si spatiilor care se alterneaza, incepand cu banda (negru): „212222" =
// banda 2, spatiu 1, banda 2, spatiu 2, banda 2, spatiu 2. Ultimul (STOP) are
// 7, fiindca se termina cu doua benzi.
const TIPARE = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

// Code 128-B stie doar ASCII 32..126. Orice altceva (diacritice, de pilda) ar
// face un cod pe care scannerul il citeste altfel decat scrie sub el — mai rau
// decat sa nu-l aiba deloc. De-aia curatam inainte, nu dupa.
function curat(text) {
  return String(text == null ? "" : text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 48);
}

// Sirul de module: „1" = negru, „0" = alb. Separat de desen, ca sa poata fi
// verificat de un test fara sa ne uitam la SVG.
function benzi(text) {
  const t = curat(text);
  if (!t) return "";
  const valori = [START_B];
  let suma = START_B;
  for (let i = 0; i < t.length; i++) {
    const v = t.charCodeAt(i) - 32;
    valori.push(v);
    suma += v * (i + 1);
  }
  valori.push(suma % 103);
  valori.push(STOP);
  let out = "";
  for (const v of valori) {
    const tipar = TIPARE[v];
    for (let i = 0; i < tipar.length; i++) {
      out += (i % 2 === 0 ? "1" : "0").repeat(Number(tipar[i]));
    }
  }
  return out;
}

// Aceeasi scapare ca in lib/render, dar tinuta aici ca fisierul sa nu atarne
// de nimic: codul de bare si fisa de lot se pot desena si intr-un test fara
// baza de date, iar lib/render trage dupa el auth si db.
const escXml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// SVG gata de pus in pagina. Latimea unui modul e in milimetri, ca fisa se
// masoara pe hartie, nu pe ecran: sub 0,25 mm scannerele incep sa greseasca,
// de-aia e minimul pus in cod si nu lasat la nimereala.
//
//   inalt      — inaltimea benzilor, mm
//   modul      — latimea unui modul, mm
//   subtitlu   — true scrie textul sub cod (implicit), false il ascunde
//   liniste    — zona alba obligatorie de la capete, in module (min. 10)
function svg(text, optiuni) {
  const o = optiuni || {};
  const t = curat(text);
  const biti = benzi(t);
  if (!biti) return "";
  const modul = Math.max(0.25, Number(o.modul) || 0.3);
  const inalt = Math.max(5, Number(o.inalt) || 12);
  const liniste = Math.max(10, Number(o.liniste) || 10);
  const cuText = o.subtitlu !== false;
  const inaltText = cuText ? 3.6 : 0;
  const latime = (biti.length + liniste * 2) * modul;
  const inaltTotal = inalt + inaltText + (cuText ? 1 : 0);

  // Benzile vecine se desenează ca un singur dreptunghi: mai putine noduri in
  // pagina si, la tipar, fara firul alb subtire care apare intre doua
  // dreptunghiuri lipite — exact firul care face scannerul sa rateze.
  let d = "";
  let i = 0;
  while (i < biti.length) {
    if (biti[i] === "1") {
      let j = i;
      while (j < biti.length && biti[j] === "1") j++;
      const x = ((liniste + i) * modul).toFixed(3);
      const w = ((j - i) * modul).toFixed(3);
      d += `<rect x="${x}" y="0" width="${w}" height="${inalt.toFixed(2)}"/>`;
      i = j;
    } else i++;
  }
  const textSvg = cuText
    ? `<text x="${(latime / 2).toFixed(2)}" y="${(inalt + inaltText).toFixed(2)}" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${(inaltText * 0.95).toFixed(2)}" letter-spacing="0.2" fill="#000">${escXml(t)}</text>`
    : "";
  return (
    `<svg class="cod-bare" xmlns="http://www.w3.org/2000/svg" width="${latime.toFixed(2)}mm" height="${inaltTotal.toFixed(2)}mm"` +
    ` viewBox="0 0 ${latime.toFixed(2)} ${inaltTotal.toFixed(2)}" shape-rendering="crispEdges" role="img" aria-label="cod de bare ${escXml(t)}">` +
    `<rect x="0" y="0" width="${latime.toFixed(2)}" height="${inaltTotal.toFixed(2)}" fill="#fff"/>` +
    `<g fill="#000">${d}</g>${textSvg}</svg>`
  );
}

module.exports = { svg, benzi, curat, esc: escXml, TIPARE };
