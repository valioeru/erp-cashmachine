"use strict";
// Schimburile și întrebarea „cine e în tură la ora asta".
//
// Până acum ERP-ul știa CE UTILAJE știe fiecare om, dar nu și CÂND vine la
// lucru. Rezultatul se vedea la alocare: lista arăta toți cei calificați, deci
// și pe cel care în ziua aia e pe tura de noapte, și pe cel care sâmbăta nu
// vine deloc. Alocarea ieșea curată pe hârtie și imposibilă în hală.
//
// Orele de pornire NU sunt scrise în piatră: se setează din pagina de program
// și se țin în „setari_app". Cele de mai jos sunt doar punctul de plecare, ca
// aplicația să funcționeze și înainte ca cineva să intre în configurare.
const IMPLICITE = [
  { cod: "S1", start: 6, ore: 8 },
  { cod: "S2", start: 14, ore: 8 },
  { cod: "S3", start: 22, ore: 8 },
  { cod: "zi", start: 8, ore: 8 },
];
const doua = (n) => String(Math.floor(n)).padStart(2, "0");
function construieste(lista) {
  const out = {};
  for (const x of lista) {
    const start = Math.min(23, Math.max(0, Number(x.start) || 0));
    const ore = Math.min(24, Math.max(1, Number(x.ore) || 8));
    const sfarsit = (start + ore) % 24;
    out[x.cod] = { cod: x.cod, start, ore, eticheta: `${x.cod} · ${doua(start)}–${doua(sfarsit)}` };
  }
  return out;
}
let SCHIMBURI = construieste(IMPLICITE);
const CODURI = IMPLICITE.map((x) => x.cod);

// Chemată o dată la pornire, din server.js, cu ce s-a salvat în configurare.
// Un cod necunoscut sau o oră imposibilă se ignoră: mai bine rămâne ora
// implicită decât să dispară un schimb întreg din aplicație.
function configureaza(lista) {
  if (!Array.isArray(lista) || !lista.length) return SCHIMBURI;
  const pornire = IMPLICITE.map((x) => {
    const g = lista.find((y) => String(y.cod) === x.cod);
    return g ? { cod: x.cod, start: g.start, ore: g.ore } : x;
  });
  SCHIMBURI = construieste(pornire);
  return SCHIMBURI;
}
const toate = () => CODURI.map((c) => SCHIMBURI[c]);

// „s1", „S 1", „tura 1", „zi", „day" — toate ajung la același schimb. Fișierele
// de planificare vin scrise de oameni diferiți, iar un cod nerecunoscut ar
// însemna, în practică, un om care dispare din planificare fără să spună
// nimeni de ce.
function normalizeaza(v) {
  const s = String(v == null ? "" : v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!s) return null;
  if (/^(s|tura|schimb|shift)?1$/.test(s)) return "S1";
  if (/^(s|tura|schimb|shift)?2$/.test(s)) return "S2";
  if (/^(s|tura|schimb|shift)?3$/.test(s)) return "S3";
  if (/^(zi|day|dayshift|turazi|normal|tesa)$/.test(s)) return "zi";
  return null;
}

const ziPlus = (data, n) => {
  const d = new Date(String(data) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(data);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Intervalul pe care îl acoperă un schimb pornit în ziua „data". Pentru S3 el
// trece peste miezul nopții, deci se întoarce și bucata din ziua următoare —
// altfel o alocare la 2 noaptea n-ar găsi pe nimeni, deși schimbul de noapte e
// în hală exact atunci.
function interval(cod, data) {
  const s = SCHIMBURI[cod];
  if (!s) return [];
  const sfarsit = s.start + s.ore;
  if (sfarsit <= 24) return [{ data, de: s.start, la: sfarsit }];
  return [
    { data, de: s.start, la: 24 },
    { data: ziPlus(data, 1), de: 0, la: sfarsit - 24 },
  ];
}

// E omul în tură în ziua „ziua", la ora „ora", dacă schimbul lui a pornit în
// ziua „dataProgram"? Ora de start a alocării e cea care contează: dacă omul
// intră la 14 și comanda pornește la 13, nu e acolo când începe lucrul.
function acopera(cod, dataProgram, ziua, ora) {
  const o = Number(ora);
  if (!Number.isFinite(o)) return false;
  for (const x of interval(cod, dataProgram)) {
    if (x.data === ziua && o >= x.de && o < x.la) return true;
  }
  return false;
}

// Din toate rândurile de program, cine e în tură la ziua și ora cerute.
// „randuri" = [{ resursa_id, data, schimb }]. Întoarce un Set de id-uri.
function disponibili(randuri, ziua, ora) {
  const set = new Set();
  for (const r of randuri || []) {
    const cod = normalizeaza(r.schimb);
    if (!cod) continue;
    if (acopera(cod, String(r.data).slice(0, 10), String(ziua).slice(0, 10), ora)) set.add(Number(r.resursa_id));
  }
  return set;
}

// Eticheta scurtă pentru grilă: „S2 · 14–22".
function eticheta(cod) {
  const s = SCHIMBURI[normalizeaza(cod) || cod];
  return s ? s.eticheta : String(cod || "");
}

module.exports = { CODURI, IMPLICITE, configureaza, toate, normalizeaza, interval, acopera, disponibili, eticheta, ziPlus };
