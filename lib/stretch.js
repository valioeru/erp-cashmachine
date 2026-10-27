"use strict";
// Folia stretch: greutatea și lungimea, una din cealaltă.
//
// Datele date de Vali pe 27.10.2026:
//   • lățimea e MEREU 50 cm;
//   • densitatea foliei e 0,918 g/cm³ (polietilenă liniară de joasă densitate).
//
// SOCOTEALA, scrisă o dată ca s-o poată verifica oricine:
//
//   volumul  = lungime × lățime × grosime
//   greutatea = volumul × densitatea
//
//   În metri și kilograme: 0,918 g/cm³ înseamnă 918 kg/m³, iar grosimea în
//   microni se împarte la un milion ca să ajungă în metri. Deci
//
//     kg = L(m) × 0,5(m) × µ × 10⁻⁶(m) × 918(kg/m³)
//        = L × µ × 0,000459
//
//   Verificare pe role adevărate:
//     23µ, 300 m  →  300 × 23 × 0,000459 = 3,17 kg   (o rolă manuală obișnuită)
//     17µ, 1500 m →  1500 × 17 × 0,000459 = 11,70 kg (o rolă de mașină)
//   Amândouă pică exact pe greutățile din piață, deci formula e bună.
//
// DE CE E AICI, ȘI NU ÎN PAGINĂ:
//   E singurul loc în care se scrie. Dacă ar fi calculată și în browser, și pe
//   server, cele două ar începe să difere la a treia zecimală, iar cineva ar
//   căuta diferența într-o comandă de 500 kg.

const LATIME_M = 0.5; // 50 cm, mereu
const DENSITATE_G_CM3 = 0.918;

// Câte kilograme are un metru de folie de un micron. Din el ies amândouă
// direcțiile, deci dacă vreodată se schimbă lățimea sau materialul, se
// schimbă într-un singur loc.
function kgPeMetruMicron(latimeM, densitate) {
  const l = Number(latimeM === undefined ? LATIME_M : latimeM);
  const d = Number(densitate === undefined ? DENSITATE_G_CM3 : densitate);
  // d g/cm³ = d × 1000 kg/m³; grosimea de 1 µm = 1e-6 m.
  return l * 1e-6 * (d * 1000);
}

function rotunjit(n, zecimale) {
  const f = Math.pow(10, zecimale);
  return Math.round(n * f) / f;
}

// Greutatea unei role, din lungime și grosime.
function greutateDinLungime(lungimeM, grosimeMicroni, optiuni) {
  const L = Number(lungimeM);
  const g = Number(grosimeMicroni);
  if (!isFinite(L) || !isFinite(g) || L <= 0 || g <= 0) return null;
  const o = optiuni || {};
  return rotunjit(L * g * kgPeMetruMicron(o.latime, o.densitate), 3);
}

// Lungimea unei role, din greutate și grosime.
function lungimeDinGreutate(greutateKg, grosimeMicroni, optiuni) {
  const kg = Number(greutateKg);
  const g = Number(grosimeMicroni);
  if (!isFinite(kg) || !isFinite(g) || kg <= 0 || g <= 0) return null;
  const o = optiuni || {};
  const pe = g * kgPeMetruMicron(o.latime, o.densitate);
  if (!(pe > 0)) return null;
  // Lungimea se rotunjește la metru: nimeni nu taie folie la centimetru, iar
  // „287,4316 m" scris pe o comandă dă impresia unei precizii care nu există.
  return Math.round(kg / pe);
}

// Se poate socoti pentru familia asta?
//
// NU se verifică după numele familiei: Vali poate redenumi „Folie stretch" în
// „Stretch LLDPE" din Configurări, iar conversia ar dispărea fără ca nimeni
// să înțeleagă de ce. Se verifică după ce cere de fapt formula — o grosime în
// microni și o lungime în metri. Dacă familia le are, socoteala are sens;
// dacă nu, n-are.
function potriveste(campuri) {
  const num = (nume, um) =>
    (campuri || []).find(
      (c) =>
        c.fel === "numar" &&
        String(c.nume || "").toLowerCase().indexOf(nume) === 0 &&
        String(c.um || "").toLowerCase().indexOf(um) === 0
    );
  const grosime = num("grosime", "micron");
  const lungime = num("lungime", "m");
  if (!grosime || !lungime) return null;

  // Lățimea trebuie să fie FIXĂ, altfel constanta de 50 cm e greșită prin
  // definiție.
  //
  // Prins de propriul test: banda adezivă are și ea grosime în microni și
  // lungime de rolă în metri, deci trecea — și i-ar fi apărut o căsuță de
  // greutate socotită pe 50 cm lățime și densitatea foliei. O bandă de 48 mm
  // ar fi ieșit de zece ori mai grea, iar cifra n-ar fi dat nicio eroare.
  //
  // Regula e simplă și adevărată: dacă familia are lățimea ca o caracteristică
  // pe care o alegi, lățimea NU e fixă, deci formula asta nu i se aplică.
  const faraDiacritice = (t) =>
    String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const areLatime = (campuri || []).some((c) => faraDiacritice(c.nume).indexOf("latime") === 0);
  if (areLatime) return null;
  // „Lungime fără clapetă (mm)" de la pungi NU trebuie să pice aici: unitatea
  // ei e „mm", nu „m", iar verificarea de mai sus ar accepta-o fiindcă „mm"
  // începe cu „m". De-aia se cere unitatea exactă.
  if (String(lungime.um).toLowerCase() !== "m") return null;
  return {
    grosime_id: grosime.id,
    lungime_id: lungime.id,
    latime_m: LATIME_M,
    densitate: DENSITATE_G_CM3,
    kg_pe_metru_micron: kgPeMetruMicron(),
  };
}

module.exports = {
  LATIME_M,
  DENSITATE_G_CM3,
  kgPeMetruMicron,
  greutateDinLungime,
  lungimeDinGreutate,
  potriveste,
};
