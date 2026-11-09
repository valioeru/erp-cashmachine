"use strict";
// Furnizorul de pe linia comenzii: când trebuie ales și din ce.
//
// CE A CERUT VALI, 06.11.2026:
//   „La comandă, dacă marfa nu e în stoc, n-ai cum să alegi furnizor."
//   „Să fie furnizor obligatoriu doar dacă găsește produsul în stoc, altfel să
//    fie pusă fără, și furnizorul se alocă când se alocă materialul în
//    producție."
//
// La Folie stretch, „Furnizor" era o caracteristică obligatorie a produsului,
// cu lista goală: nicio folie nouă nu se mai putea pune pe comandă. Acum:
//   • furnizorul NU mai face parte din produsul ales pe comandă — produsul e
//     cel descris de celelalte caracteristici, cel care stă pe raft;
//   • dacă produsul e pe stoc în CT-Park și paleții au furnizorul scris,
//     agentul alege furnizorul dintre ei (obligatoriu): așa depozitul știe ce
//     paleți scoate;
//   • dacă nu e pe stoc, linia merge fără furnizor; îl alege producția când
//     alocă materialul, iar de acolo ajunge pe linie și pe paleții produși.
//
// Aici e doar socoteala, fără bază de date, ca să poată fi verificată de un
// test. Citirile din bază stau în modules/comenzi.js.

// Caracteristica „Furnizor" a unei categorii de produs, după nume — la fel ca
// în modules/cod-produs.js (furnizorulScris).
function eFurnizor(c) {
  return /furniz/i.test(String((c && c.nume) || ""));
}

// Furnizorul care se mută de pe produs pe linia comenzii: cel ALES DINTR-O
// LISTĂ (Folie stretch). Ăsta e cazul de care s-a plâns Vali: o listă de
// furnizori din care agentul nu are ce alege când marfa nu e pe stoc.
//
// Furnizorul scris ca TEXT LIBER (familiile „furnizor + denumire", 05.11.2026)
// rămâne pe produs: acolo el face parte din produs — „WBV GmbH · Folie
// aluminiu" are codul WBVFOL01 tocmai după furnizor —, iar fără el produsele a
// doi furnizori ar cădea pe același cod.
function eFurnizorDeLinie(c) {
  return eFurnizor(c) && String((c && c.fel) || "lista") !== "text";
}

const NESCRIS = "furnizor nescris pe palet";

// Din stocul produsului, grupat pe furnizorul paletului, ce poate alege agentul.
// `randuri` = [{ furnizor_id, furnizor_nume, furnizor_text, cantitate, um, paleti }]
//
// Întoarce { optiuni, nescris, cere, total }:
//   optiuni — furnizorii știuți, cu cât au pe stoc, cei mai plini întâi;
//   nescris — stocul de pe paleții fără furnizor scris (sau null);
//   cere    — dacă furnizorul e obligatoriu: e stoc ȘI se știe măcar un
//             furnizor. Stocul fără niciun furnizor scris nu are ce oferi de
//             ales, deci nu oprește comanda.
// Când se cere și există și stoc nescris, el e o opțiune în plus: agentul
// poate spune „din paleții fără furnizor".
function optiuniDinStoc(randuri) {
  const pe = new Map();
  let nescris = null;
  for (const r of randuri || []) {
    const cant = Number(r.cantitate) || 0;
    if (!(cant > 0)) continue;
    const id = Number(r.furnizor_id) || null;
    const text = String(r.furnizor_text || "").trim();
    const nume = id ? String(r.furnizor_nume || "").trim() || text || "furnizor #" + id : text;
    if (!nume) {
      if (!nescris) nescris = { cheie: "n", nume: NESCRIS, cantitate: 0, um: r.um || "", paleti: 0 };
      nescris.cantitate += cant;
      nescris.paleti += Number(r.paleti) || 0;
      continue;
    }
    const cheie = id ? "p:" + id : "t:" + text;
    if (!pe.has(cheie)) pe.set(cheie, { cheie, nume, cantitate: 0, um: r.um || "", paleti: 0 });
    const o = pe.get(cheie);
    o.cantitate += cant;
    o.paleti += Number(r.paleti) || 0;
  }
  const rotunjit = (o) => Object.assign(o, { cantitate: Math.round(o.cantitate * 1000) / 1000 });
  const optiuni = [...pe.values()].map(rotunjit).sort((a, b) => b.cantitate - a.cantitate || a.nume.localeCompare(b.nume, "ro"));
  if (nescris) rotunjit(nescris);
  const cere = optiuni.length > 0;
  const total = optiuni.reduce((s, o) => s + o.cantitate, 0) + (nescris ? nescris.cantitate : 0);
  return { optiuni: cere && nescris ? optiuni.concat([nescris]) : optiuni, nescris, cere, total: Math.round(total * 1000) / 1000 };
}

// Ce scrie sub produs, pe linie.
function mesaj(s) {
  const cant = (o) => `${Number(o.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${o.um ? " " + o.um : ""}`;
  if (!s || !(s.total > 0)) return "Nu e pe stoc: furnizorul se alege în producție, când se alocă materialul.";
  if (s.cere) return "E pe stoc — alege furnizorul, ca depozitul să știe ce paleți scoate.";
  return `Pe stoc: ${cant(s.nescris)}, fără furnizor scris pe palet.`;
}

// Alegerea trimisă de formular → ce se scrie pe linie. „" = nimic ales.
//   p:<id>  — un furnizor din Parteneri
//   t:<text> — un furnizor scris doar ca text pe palet
//   n        — paleții fără furnizor scris
function citesteAlegerea(v) {
  const s = String(v == null ? "" : v).trim();
  let m;
  if ((m = s.match(/^p:(\d{1,9})$/))) return { furnizor_id: Number(m[1]), furnizor_text: null };
  if ((m = s.match(/^t:(.{1,120})$/))) return { furnizor_id: null, furnizor_text: m[1].trim() };
  if (s === "n") return { furnizor_id: null, furnizor_text: NESCRIS };
  return null;
}

// Invers: ce e scris pe linie → cheia din formular, ca la modificarea comenzii
// lista să pornească de la furnizorul ales înainte.
function cheiaLiniei(l) {
  if (!l) return "";
  if (Number(l.furnizor_id)) return "p:" + Number(l.furnizor_id);
  const t = String(l.furnizor_text || "").trim();
  if (!t) return "";
  return t === NESCRIS ? "n" : "t:" + t;
}

// Ce se scrie pe ecran pentru furnizorul unei linii.
function eticheta(l, numePartener) {
  if (!l) return "";
  if (Number(l.furnizor_id)) return String(numePartener || "").trim() || "furnizor #" + Number(l.furnizor_id);
  const t = String(l.furnizor_text || "").trim();
  return t === NESCRIS ? "paleții fără furnizor scris" : t;
}

// De unde a venit furnizorul de pe linie — se scrie lângă nume, ca să se
// știe dacă l-a ales agentul din stoc sau l-a pus producția mai târziu.
const SURSE = {
  stoc: "ales din stoc",
  productie: "din producție",
  aprovizionare: "comandat de depozit",
};
const sursa = (s) => SURSE[String(s || "")] || "";

module.exports = { eFurnizor, eFurnizorDeLinie, optiuniDinStoc, mesaj, citesteAlegerea, cheiaLiniei, eticheta, sursa, NESCRIS };
