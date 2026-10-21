"use strict";
// Logica unei comenzi către furnizor, scoasă din pagină ca să poată fi
// verificată fără bază de date și fără browser.
//
// Trei lucruri stau aici, pentru că trei lucruri se pot greși tăcut:
//
//   1. STATUSUL DUPĂ RECEPȚIE. „Primită" nu e o bifă pe care o apasă cineva,
//      e o concluzie din cantități. Dacă ar fi bifă, ar rămâne bifată pe
//      comenzi din care n-a venit decât jumătate, iar lista de „în curs" ar
//      minți exact în cazul care contează.
//
//   2. TOTALURILE PE MONEDĂ. Nu se adună lei cu euro. Se adună separat și se
//      arată separat; echivalentul în lei e o comparație, nu o sumă contabilă,
//      și scrie pe pagină la ce curs s-a făcut.
//
//   3. ÎNTÂRZIEREA. Diferența dintre data cerută de noi și ziua în care a
//      intrat marfa. E singura măsură cinstită a unui furnizor și e singurul
//      motiv pentru care cele două date stau pe comandă, nu într-un comentariu.

const DESCHISE = ["ciorna", "trimisa", "confirmata", "partial"];

const STATUS_ETICHETA = {
  ciorna: "Ciornă",
  trimisa: "Trimisă",
  confirmata: "Confirmată",
  partial: "Primită parțial",
  primita: "Primită",
  anulata: "Anulată",
};

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Rotunjirea la bani, cu plasă pentru reprezentarea binară.
//
// 2,5 kg × 1,89 €/kg dă în virgulă mobilă 4,7249999999999996, iar un
// `Math.round(x * 100) / 100` scris din reflex îl coboară la 4,72 în loc de
// 4,73. Un ban pe linie, pe o comandă de treizeci de poziții, și totalul nu se
// mai potrivește cu factura furnizorului — iar nimeni nu caută diferența în
// rotunjire, se caută în prețuri. Se taie întâi zgomotul de la coada
// numărului, abia apoi se rotunjește — și anume DUPĂ înmulțirea cu 100, nu
// înainte: 4,725 × 100 dă 472,49999999999994, deci curățarea făcută devreme
// n-ar folosi la nimic. Asta a și fost prima încercare, și pica la fel.
//
// Doisprezece cifre semnificative acoperă sume până la ordinul miliardelor cu
// tot cu bani; peste atât n-avem ce căuta aici.
const BANI = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
};

// Cât s-a primit din fiecare linie, adunat la nivel de comandă.
//
// „Primită" cere ca FIECARE linie să fie acoperită. O comandă din care a venit
// tot ce e scump și n-a venit șurubul de 2 lei tot nu e primită — cineva
// trebuie să-l mai ceară o dată.
function statusDupaReceptie(linii, statusCurent) {
  const l = Array.isArray(linii) ? linii : [];
  if (!l.length) return statusCurent || "ciorna";
  let toate = true;
  let ceva = false;
  for (const x of l) {
    const cerut = nr(x.cantitate);
    const primit = nr(x.cantitate_primita);
    if (primit > 0) ceva = true;
    // O linie cu cantitate 0 (adăugată din greșeală) nu ține comanda deschisă.
    if (cerut > 0 && primit + 0.0001 < cerut) toate = false;
  }
  if (toate && ceva) return "primita";
  if (ceva) return "partial";
  // Nimic primit: comanda rămâne unde era, nu coboară înapoi la ciornă.
  return statusCurent && statusCurent !== "primita" && statusCurent !== "partial" ? statusCurent : "trimisa";
}

// Valoarea unei linii. Prețul lipsă NU e zero: e necunoscut.
//
// `Number(null)` dă 0, un zero finit, nenegativ, care trece de orice gardă —
// aceeași capcană care era cât pe ce să arate agentului prețul de achiziție la
// RFQ. Aici ar transforma o comandă neprețuită într-una „de 0 lei", iar totalul
// paginii ar arăta cinstit și ar fi fals. Deci: fără preț, fără valoare.
function valoareLinie(linie) {
  const l = linie || {};
  const p = l.pret_unitar;
  if (p === null || p === undefined || p === "") return null;
  const pret = Number(p);
  if (!Number.isFinite(pret) || pret < 0) return null;
  return BANI(pret * nr(l.cantitate));
}

function totalComanda(linii) {
  let suma = 0;
  let faraPret = 0;
  for (const l of Array.isArray(linii) ? linii : []) {
    const v = valoareLinie(l);
    if (v === null) faraPret++;
    else suma += v;
  }
  return { total: BANI(suma), faraPret };
}

// Totalurile pe monedă, pentru o listă de comenzi. Separat, niciodată adunate.
function totaluriPeMoneda(comenzi) {
  const pe = new Map();
  for (const c of Array.isArray(comenzi) ? comenzi : []) {
    const m = String((c && c.moneda) || "RON").toUpperCase();
    pe.set(m, BANI((pe.get(m) || 0) + nr(c.total)));
  }
  return pe;
}

// Câte zile a întârziat furnizorul. Negativ = a venit mai devreme.
// Fără una din cele două date nu există răspuns, și se spune asta cu null,
// nu cu zero — zero ar însemna „a fost punctual".
function intarziere(dataSolicitata, dataReceptie) {
  const a = String(dataSolicitata || "").slice(0, 10);
  const b = String(dataReceptie || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// Numărul următor, pe an. „CF" ca să nu se confunde cu facturile sau cu
// comenzile clienților, care au deja numere proprii.
function numarUrmator(ultimul, an) {
  const anul = String(an || new Date().getFullYear());
  const m = String(ultimul || "").match(/^CF-(\d{4})-(\d+)$/);
  const n = m && m[1] === anul ? parseInt(m[2], 10) + 1 : 1;
  return "CF-" + anul + "-" + String(n).padStart(4, "0");
}

// Corpul emailului către furnizor. Text simplu, nu HTML: ajunge întreg și în
// clienții de mail vechi, iar cine îl citește pe telefon nu primește un tabel
// care nu încape pe ecran.
function corpEmail({ comanda, linii, furnizor, semnatura }) {
  const c = comanda || {};
  const randuri = (Array.isArray(linii) ? linii : []).map((l, i) => {
    const cant = nr(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
    const um = l.um ? " " + l.um : "";
    const v = valoareLinie(l);
    const pret = v === null ? "preț de confirmat" : `${Number(l.pret_unitar).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${c.moneda || "RON"}/${l.um || "buc"}`;
    return `${i + 1}. ${l.denumire} — ${cant}${um} — ${pret}`;
  });
  const t = totalComanda(linii);
  const parti = [];
  parti.push(`Bună ziua${furnizor ? ", " + furnizor : ""},`);
  parti.push("");
  parti.push(`Vă transmitem comanda ${c.numar || ""}, din data de ${String(c.data || "").slice(0, 10)}.`);
  parti.push("");
  parti.push(randuri.join("\n"));
  parti.push("");
  if (t.faraPret === 0) {
    parti.push(`Total comandă: ${t.total.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c.moneda || "RON"}`);
  } else {
    parti.push(`Total pe pozițiile cu preț: ${t.total.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c.moneda || "RON"} (${t.faraPret} ${t.faraPret === 1 ? "poziție" : "poziții"} fără preț, vă rugăm să ni-l confirmați)`);
  }
  if (c.data_solicitata) parti.push(`Data de livrare solicitată: ${String(c.data_solicitata).slice(0, 10)}`);
  if (c.observatii) {
    parti.push("");
    parti.push(String(c.observatii));
  }
  parti.push("");
  parti.push("Vă rugăm să confirmați primirea comenzii și termenul de livrare.");
  parti.push("");
  parti.push(semnatura || "Cu stimă,\nCash Machine SRL");
  return parti.join("\n");
}

module.exports = {
  DESCHISE,
  STATUS_ETICHETA,
  BANI,
  statusDupaReceptie,
  valoareLinie,
  totalComanda,
  totaluriPeMoneda,
  intarziere,
  numarUrmator,
  corpEmail,
};
