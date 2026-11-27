"use strict";
// Statusul pe produs, într-o comandă cu mai multe produse.
//
// CEREREA LUI VALI, 27.11.2026: „Dacă sunt mai multe produse în comandă, să se
// poată schimba statusul ca livrat etc. și doar la unul sau mai multe produse,
// nu doar la toată comanda."
//
// CUM SE ȚINE. Comanda își păstrează statusul ei (`comenzi.status`), pe care
// îl mută producția, depozitul, facturarea și logistica (lib/stadiu-comanda.js).
// O linie poate avea, în plus, statusul EI:
//   comenzi_linii.status_linie         — starea pusă de om pe produs;
//   comenzi_linii.status_linie_comanda — ce status avea comanda în clipa aceea.
// Fără `status_linie`, produsul are statusul comenzii.
//
// CÂND MAI E VALABIL statusul pus pe produs (`efectiv`):
//   • cât comanda n-a mai fost mutată de atunci, sau
//   • cât produsul e ÎNAINTEA comenzii pe drum (livrat, deși comanda e abia
//     „gata de livrare"), ori e anulat.
// Când comanda trece mai departe și ajunge produsul din urmă sau îl depășește,
// produsul merge din nou odată cu ea. Așa nu trebuie agățat nimic în cele cinci
// locuri care mută singure statusul comenzii.
//
// CÂND SE MUTĂ ȘI COMANDA: dacă, după o schimbare pe produse, TOATE produsele
// au aceeași stare, comanda trece pe starea aceea (cu aceeași regulă de
// drepturi ca la „Schimbă status") și liniile rămân fără stare proprie.
//
// CE NU FACE: nu mișcă stoc, nu atinge `cantitate_livrata`, nu emite factură.
// E un marcaj. Marfa și banii merg tot prin livrarea și facturarea parțială.
//
// Partea de sus e fără bază de date, ca să se poată verifica într-un test.
const STARI = require("./comenzi-stari");

const RESET = "ca_comanda";
const rang = (s) => {
  const i = STARI.FLUX.indexOf(String(s || ""));
  return i === -1 ? -1 : i;
};

// Statusul pe care îl are produsul acum.
function efectiv(linie, comanda) {
  const alComenzii = String((comanda && comanda.status) || "");
  const pus = String((linie && linie.status_linie) || "").trim();
  if (!pus || pus === alComenzii) return alComenzii;
  // Comanda anulată: toate produsele sunt anulate.
  if (alComenzii === "anulata") return alComenzii;
  if (String((linie && linie.status_linie_comanda) || "") === alComenzii) return pus;
  if (pus === "anulata") return pus;
  return rang(pus) > rang(alComenzii) && rang(alComenzii) >= 0 ? pus : alComenzii;
}
const areStatusPropriu = (linie, comanda) => efectiv(linie, comanda) !== String((comanda && comanda.status) || "");

// Rezumatul pentru lista de comenzi: „1 din 3 produse: livrată".
// Gol când toate produsele merg cu comanda.
function rezumat(linii, comanda) {
  const toate = linii || [];
  const proprii = toate.filter((l) => areStatusPropriu(l, comanda));
  if (!proprii.length) return "";
  const pe = new Map();
  for (const l of proprii) {
    const s = efectiv(l, comanda);
    pe.set(s, (pe.get(s) || 0) + 1);
  }
  const bucati = [...pe.entries()]
    .sort((a, b) => rang(b[0]) - rang(a[0]))
    .map(([s, n]) => `${n} ${STARI.PASI_ETICHETE[s] || STARI.TEXTE[s] || s.replace(/_/g, " ")}`);
  return `${proprii.length} din ${toate.length} ${toate.length === 1 ? "produs" : "produse"}: ${bucati.join(", ")}`;
}

// Ce se scrie, pentru o cerere de schimbare.
//   comanda, linii (toate liniile comenzii), ids (cele bifate), status (starea aleasă sau RESET)
//   permise: stările pe care omul le poate pune pe comanda asta
// Întoarce { ok, deScris: [{ id, status_linie, status_linie_comanda }], schimbari: [{ linie, vechi, nou }], comandaPe }
// sau { ok: false, eroare }.
function hotaraste({ comanda, linii, ids, status, permise }) {
  const cerut = String(status || "").trim();
  const alese = new Set((ids || []).map(Number).filter((x) => x > 0));
  const aleComenzii = (linii || []).filter((l) => alese.has(Number(l.id)));
  if (!aleComenzii.length) return { ok: false, eroare: "Bifează cel puțin un produs din comandă." };
  if (!(permise || []).length) return { ok: false, eroare: "Pe comanda asta n-ai pași de mutat." };
  if (String(comanda.status) === "anulata") return { ok: false, eroare: "Comanda e anulată: produsele ei nu mai au alt status." };
  if (String(comanda.status) === "ciorna") return { ok: false, eroare: "Comanda e ciornă: validează-o întâi." };
  if (cerut !== RESET && !(permise || []).includes(cerut)) return { ok: false, eroare: "Starea aleasă nu e una dintre cele pe care le poți pune tu." };
  const alComenzii = String(comanda.status || "");
  const deScris = [];
  const schimbari = [];
  for (const l of aleComenzii) {
    const vechi = efectiv(l, comanda);
    const nou = cerut === RESET || cerut === alComenzii ? alComenzii : cerut;
    const propriu = nou === alComenzii ? null : nou;
    if (String(l.status_linie || "") !== String(propriu || "") || (propriu && String(l.status_linie_comanda || "") !== alComenzii)) {
      deScris.push({ id: Number(l.id), status_linie: propriu, status_linie_comanda: propriu ? alComenzii : null });
    }
    if (vechi !== nou) schimbari.push({ linie: l, vechi, nou });
  }
  // După schimbare: au toate produsele aceeași stare, alta decât a comenzii?
  const dupa = (linii || []).map((l) => {
    const s = deScris.find((x) => x.id === Number(l.id));
    return efectiv(s ? { status_linie: s.status_linie, status_linie_comanda: s.status_linie_comanda } : l, comanda);
  });
  const una = dupa.length && dupa.every((s) => s === dupa[0]) ? dupa[0] : null;
  const comandaPe = una && una !== alComenzii && (permise || []).includes(una) ? una : null;
  return { ok: true, deScris, schimbari, comandaPe };
}

const text = (s) => STARI.PASI_ETICHETE[s] || STARI.TEXTE[s] || String(s || "").replace(/_/g, " ");

module.exports = { RESET, efectiv, areStatusPropriu, rezumat, hotaraste, text };
