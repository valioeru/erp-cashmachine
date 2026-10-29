"use strict";
// Țara, județul și localitatea clientului — ce cere SmartBill pe o factură.
//
// CE S-A ÎNTÂMPLAT (29.10.2026): factura FCT-1 către Ding Communication n-a
// plecat în SmartBill. Răspunsul: „(400) țara trebuie specificată". ERP-ul
// trimitea clientul doar cu nume, CUI și adresa ca un singur șir de text —
// iar în fișa partenerului nu exista nici țară, nici județ, nici localitate,
// ca să aibă de unde le trimite.
//
// De unde le luăm, în ordinea asta:
//
//   1. Din fișa clientului, dacă sunt scrise acolo (câmpurile noi).
//   2. Din adresa importată din SmartBill. Aproape toți clienții au venit de
//      acolo, cu adresa scrisă după același tipar: „…, Loc.Dobridor, Jud.
//      Dolj, Tara Romania". E chiar forma în care SmartBill le ține, deci nu
//      e o ghicitoare — se citesc și se scriu în fișă, ca data viitoare să
//      fie deja acolo.
//   3. Țara „Romania" pentru un CUI românesc. Un CUI fără prefix străin e
//      al unei firme din România.
//
// Ce nu se poate afla sigur NU se ghicește pe factură. O adresă scrisă de
// mână („Str. Buiacului 2 … Mogosoaia"), un client fără adresă, un client
// străin — pentru ei se arată un formular scurt, cu ce s-a putut deduce deja
// completat, iar omul confirmă. O factură e un document fiscal; un județ
// pus greșit pleacă la ANAF prin e-Factura.
//
// Numele de județe sunt scrise ca în SmartBill, fără diacritice („Bucuresti",
// „Dambovita", „Bistrita-Nasaud") — așa apar în adresele importate de acolo,
// deci așa le primește înapoi. La București, localitatea e sectorul („Sector
// 2"), tot ca în datele lui SmartBill.

const JUDETE = [
  "Alba", "Arad", "Arges", "Bacau", "Bihor", "Bistrita-Nasaud", "Botosani", "Braila", "Brasov",
  "Bucuresti", "Buzau", "Calarasi", "Caras-Severin", "Cluj", "Constanta", "Covasna", "Dambovita",
  "Dolj", "Galati", "Giurgiu", "Gorj", "Harghita", "Hunedoara", "Ialomita", "Iasi", "Ilfov",
  "Maramures", "Mehedinti", "Mures", "Neamt", "Olt", "Prahova", "Salaj", "Satu Mare", "Sibiu",
  "Suceava", "Teleorman", "Timis", "Tulcea", "Valcea", "Vaslui", "Vrancea",
];

const ROMANIA = "Romania";

// Prefixul de TVA al țărilor din UE → numele țării, cum îl scrie SmartBill
// (românește, fără diacritice). Folosit DOAR ca valoare de pornire în
// formular: omul o vede și o poate schimba înainte să plece factura.
const TARI_UE = {
  AT: "Austria", BE: "Belgia", BG: "Bulgaria", CY: "Cipru", CZ: "Cehia", DE: "Germania", DK: "Danemarca",
  EE: "Estonia", EL: "Grecia", GR: "Grecia", ES: "Spania", FI: "Finlanda", FR: "Franta", HR: "Croatia",
  HU: "Ungaria", IE: "Irlanda", IT: "Italia", LT: "Lituania", LU: "Luxemburg", LV: "Letonia", MT: "Malta",
  NL: "Olanda", PL: "Polonia", PT: "Portugalia", SE: "Suedia", SI: "Slovenia", SK: "Slovacia",
};

function faraDiacritice(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t");
}

function curat(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

// „România", „ROMANIA", „RO", „ROU" → „Romania", cum o scrie SmartBill.
// Altfel țara rămâne cum a fost scrisă, fără diacritice.
function taraCanonica(t) {
  const c = curat(faraDiacritice(t));
  if (!c) return "";
  return ["ro", "rou", "romania"].includes(c.toLowerCase()) ? ROMANIA : c;
}

// „Jud. Dâmbovița", „judetul Dambovita", „DAMBOVITA", „Municipiul Bucuresti"
// → „Dambovita" / „Bucuresti". Ce nu e un județ întoarce gol, nu ceva
// apropiat: un județ aproape-bun e tot unul greșit.
function judetCanonic(text) {
  const t = faraDiacritice(text)
    .toLowerCase()
    .replace(/\b(jud(etul|et)?|municipiul|mun)\.?\s*/g, "")
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const gasit = JUDETE.find((j) => j.toLowerCase() === t || j.toLowerCase().replace(/-/g, " ") === t.replace(/-/g, " "));
  return gasit || "";
}

// Prefixul de țară al unui cod de TVA, dacă e străin. „NL815140952B01" →
// „NL"; „RO27078460", „27078460" → "".
function prefixStrain(cui) {
  const t = String(cui == null ? "" : cui).toUpperCase().replace(/[\s.-]/g, "");
  const m = t.match(/^([A-Z]{2})[0-9A-Z]/);
  return m && m[1] !== "RO" ? m[1] : "";
}

// Citește tiparul SmartBill din adresă. Întoarce doar ce găsește explicit.
function dinAdresa(adresa) {
  const a = curat(adresa);
  const iesire = { localitate: "", judet: "", tara: "" };
  if (!a || a === "—") return iesire;
  const loc = a.match(/(?:^|,)\s*Loc\.\s*([^,]+)/i);
  const jud = a.match(/(?:^|,)\s*Jud\.\s*([^,]+)/i);
  const tara = a.match(/(?:^|,)\s*Tara\s+([^,]+)\s*$/i);
  if (jud) iesire.judet = judetCanonic(jud[1]);
  if (loc) iesire.localitate = curat(loc[1]);
  if (tara) iesire.tara = taraCanonica(tara[1]);
  // La București SmartBill pune sectorul drept localitate. Unele adrese au
  // „Sector 3, Loc.Bucuresti" — luăm sectorul, ca toate să arate la fel.
  if (iesire.judet === "Bucuresti") {
    const sector = a.match(/\bSector(?:ul)?\s*([1-6])\b/i);
    if (sector) iesire.localitate = `Sector ${sector[1]}`;
  }
  return iesire;
}

// Ce trimitem lui SmartBill pentru clientul ăsta, și ce lipsește.
//
//   sigur: true  — totul vine din fișă sau din tiparul SmartBill; se poate
//                  trimite direct.
//   sigur: false — ceva e dedus sau lipsește; se arată formularul.
//   deScrisInFisa — câmpurile citite din adresă, care merită puse în fișă.
function pentruSmartBill(partener) {
  const p = partener || {};
  const dinFisa = { tara: taraCanonica(p.tara), judet: judetCanonic(p.judet) || curat(p.judet), localitate: curat(p.localitate) };
  const citit = dinAdresa(p.adresa);
  const strain = prefixStrain(p.cui);

  const r = { tara: "", judet: "", localitate: "", lipsa: [], dedus: [], deScrisInFisa: {} };

  // Țara
  if (dinFisa.tara) r.tara = dinFisa.tara;
  else if (citit.tara) {
    r.tara = citit.tara;
    r.deScrisInFisa.tara = citit.tara;
  } else if (strain) {
    r.tara = TARI_UE[strain] || "";
    r.dedus.push("țara");
  } else {
    r.tara = ROMANIA;
    r.deScrisInFisa.tara = ROMANIA;
  }

  const inRomania = r.tara === ROMANIA;

  // Județul — cerut doar în România.
  if (inRomania) {
    if (dinFisa.judet) r.judet = dinFisa.judet;
    else if (citit.judet) {
      r.judet = citit.judet;
      r.deScrisInFisa.judet = citit.judet;
    }
    if (!JUDETE.includes(r.judet)) {
      if (r.judet) r.dedus.push("județul");
      else r.lipsa.push("județul");
    }
  }

  // Localitatea
  if (dinFisa.localitate) r.localitate = dinFisa.localitate;
  else if (citit.localitate) {
    r.localitate = citit.localitate;
    r.deScrisInFisa.localitate = citit.localitate;
  }
  if (!r.localitate) r.lipsa.push("localitatea");
  if (!r.tara) r.lipsa.push("țara");

  r.sigur = r.lipsa.length === 0 && r.dedus.length === 0;
  return r;
}

// Ce vine din formularul de confirmare, verificat.
function verifica(corp) {
  const b = corp || {};
  const tara = taraCanonica(b.tara);
  const inRomania = tara === ROMANIA;
  const judet = inRomania ? judetCanonic(b.judet) : curat(b.judet);
  const localitate = curat(b.localitate);
  const gresite = [];
  if (!tara) gresite.push("Țara lipsește.");
  if (inRomania && !judet) gresite.push("Alege județul din listă.");
  if (!localitate) gresite.push("Localitatea lipsește.");
  return { ok: gresite.length === 0, gresite, date: { tara, judet: judet || null, localitate } };
}

module.exports = { JUDETE, ROMANIA, TARI_UE, faraDiacritice, taraCanonica, judetCanonic, prefixStrain, dinAdresa, pentruSmartBill, verifica };
