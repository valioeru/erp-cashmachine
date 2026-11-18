"use strict";
// Numerele din ERP continuă după cele din SmartBill.
//
// CEREREA LUI VALI, 18.11.2026: „ia codurile pentru proforme, facturi etc. în
// continuare din SmartBill, și pentru avize" · „momentan va fi 2" — adică
// proformele și avizele se mai emit o vreme și din SmartBill, și din ERP, pe
// aceeași serie, iar ERP-ul trebuie să sară peste ce s-a emis dincolo.
//
// CUM. Sincronizarea de 30 de minute (punte/sincronizare.js) citește din
// SmartBill, de la Configurare → Serii, „Număr curent" — următorul număr pe
// care îl va da SmartBill — pentru seria de proforme și cea de avize, și îl
// trimite ERP-ului. Dacă seria e aceeași cu a ERP-ului și SmartBill e mai
// departe, contorul ERP-ului urcă până acolo. Niciodată nu coboară.
//
// CE NU POATE FACE. SmartBill nu află ce numere a dat ERP-ul. Un document
// emis din ERP între două sincronizări, sau orice document emis din ERP cât
// timp SmartBill e în urmă, primește un număr pe care SmartBill îl va da și
// el, următorului document făcut acolo. Paginile de proforme și de avize spun
// asta pe față, cu numerele (`stare`), ca omul să știe că trebuie urcat
// numărul curent și în SmartBill. Facturile nu trec pe aici: numărul lor îl
// dă SmartBill la trimitere.
//
// Fără bază de date, ca să se poată verifica într-un test.

// Ce tipuri de serie din SmartBill ne interesează și unde stau în setari_app.
const TIPURI = {
  proforma: { eticheta: "Proforma", serie: "proforma_serie", urmator: "proforma_urmator", nume: "proforme" },
  aviz: { eticheta: "Aviz", serie: "aviz_serie", urmator: "aviz_urmator", nume: "avize" },
};

// Saltul cel mai mare primit dintr-o dată. Adresa prin care vin numerele nu
// cere sesiune (vine din fila SmartBill), deci nu are voie să poată arunca
// contorul oriunde: 2.000 de documente între două citiri nu se emit.
const SALT_MAXIM = 2000;

const cheieSerie = (s) => String(s == null ? "" : s).trim().toUpperCase();
function numarIntreg(v) {
  const t = String(v == null ? "" : v).trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
function tipDin(v) {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (t === "proforma" || t === "proformă") return "proforma";
  if (t === "aviz") return "aviz";
  return null;
}

// Rândurile trimise de sincronizare: [{ tip, serie, urmator }]. Întoarce doar
// ce se poate citi limpede, o singură dată pe (tip, serie).
function curata(randuri) {
  const out = [];
  const vazute = new Set();
  for (const r of Array.isArray(randuri) ? randuri : []) {
    const tip = tipDin(r && r.tip);
    const serie = cheieSerie(r && r.serie);
    const urmator = numarIntreg(r && r.urmator);
    if (!tip || !/^[A-Z0-9-]{1,10}$/.test(serie) || urmator === null) continue;
    const k = tip + "|" + serie;
    if (vazute.has(k)) continue;
    vazute.add(k);
    out.push({ tip, serie, urmator });
  }
  return out;
}

// Ce se face cu contorul din ERP.
//   erp: { serie, urmator }   sb: { serie, urmator } (din `curata`)
// Întoarce { urca: numărul nou sau null, motiv }.
function hotaraste(erp, sb) {
  const eu = numarIntreg(erp && erp.urmator);
  if (!sb || eu === null) return { urca: null, motiv: "lipsesc numerele" };
  if (cheieSerie(erp.serie) !== cheieSerie(sb.serie)) return { urca: null, motiv: "altă serie decât în ERP" };
  if (sb.urmator <= eu) return { urca: null, motiv: sb.urmator === eu ? "la zi" : "SmartBill e în urmă" };
  if (sb.urmator - eu > SALT_MAXIM) return { urca: null, motiv: `salt prea mare (${sb.urmator - eu}), neaplicat` };
  return { urca: sb.urmator, motiv: "ERP-ul a sărit peste ce s-a emis în SmartBill" };
}

// Ce se spune omului pe pagina de proforme / avize.
//   erp: { serie, urmator }   vazut: { serie, urmator, la } sau null
// Întoarce { fel: 'necitit'|'alta-serie'|'la-zi'|'in-urma', text, dubluri }.
function stare(erp, vazut, tip) {
  const t = TIPURI[tip] || TIPURI.proforma;
  const eu = numarIntreg(erp && erp.urmator);
  const sb = vazut ? numarIntreg(vazut.urmator) : null;
  if (!vazut || sb === null || eu === null) {
    return { fel: "necitit", dubluri: 0, text: `Numărul din SmartBill n-a fost citit încă; se citește la sincronizarea de 30 de minute.` };
  }
  const cand = String(vazut.la || "").slice(0, 16);
  const citit = `SmartBill e la ${cheieSerie(vazut.serie)} ${sb}${cand ? ` (citit ${cand})` : ""}`;
  if (cheieSerie(erp.serie) !== cheieSerie(vazut.serie)) {
    // O citire de dinainte de schimbarea seriei în ERP, ori una prinsă pe altă
    // firmă din SmartBill: nu spune nimic despre seria de acum.
    return {
      fel: "alta-serie",
      dubluri: 0,
      text: `Numărul seriei ${cheieSerie(erp.serie)} din SmartBill n-a fost citit încă (ultima citire a prins seria ${cheieSerie(vazut.serie)}); se citește la sincronizarea de 30 de minute, când SmartBill e pe Cash Machine.`,
    };
  }
  if (sb >= eu) return { fel: "la-zi", dubluri: 0, text: `${citit}. ERP-ul continuă de acolo.` };
  const n = eu - sb;
  return {
    fel: "in-urma",
    dubluri: n,
    text:
      `${citit}, iar ERP-ul a ajuns la ${eu}. Următoarele ${n === 1 ? "document făcut" : n + " documente făcute"} în SmartBill ` +
      `${n === 1 ? "va primi un număr" : "vor primi numere"} deja ${n === 1 ? "folosit" : "folosite"} în ERP ` +
      `(${cheieSerie(erp.serie)} ${sb}${n > 1 ? "–" + (eu - 1) : ""}). Ca să nu se dubleze, pune în SmartBill, la Configurare → Serii, ` +
      `numărul curent al seriei de ${t.nume} pe ${eu}.`,
  };
}

module.exports = { TIPURI, SALT_MAXIM, curata, hotaraste, stare, cheieSerie, numarIntreg };
