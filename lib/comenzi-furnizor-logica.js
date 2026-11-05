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

// ---------------------------------------------------------------------------
// ORARUL DE DESCĂRCARE ȘI LIMBA COMENZII
//
// Cererea lui Vali, 05.11.2026, cu poza PDF-ului pentru WBV: „Pune orar de
// descărcare 09.00-17.30 de luni până vineri și toată comanda să fie tradusă
// în engleză."
//
// Orarul e al depozitului nostru, nu al comenzii, deci stă aici o dată și
// apare singur pe PDF și în email, în ambele limbi.
const ORAR_DESCARCARE = {
  ro: ["Orar de descărcare", "luni – vineri, 09:00 – 17:30"],
  en: ["Unloading hours", "Monday to Friday, 09:00 – 17:30"],
};
function orarDescarcare(limba) {
  const o = ORAR_DESCARCARE[limba === "en" ? "en" : "ro"];
  return o[0] + ": " + o[1];
}

// Limba în care pleacă o comandă: engleza la furnizorii din afară. Semnul e
// codul de TVA — unul care începe cu alte două litere decât RO (DE…, IT…,
// PL…) e al unei firme străine. Un CUI românesc scris fără RO (doar cifre)
// sau unul lipsă rămân în română.
function limbaImplicita(cui) {
  const t = String(cui || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const m = t.match(/^([A-Z]{2})/);
  return m && m[1] !== "RO" ? "en" : "ro";
}

// Numerele, scrise după limbă. În engleză virgula desparte miile și punctul
// zecimalele: cine citește un document englezesc vede în „84.672" optzeci și
// patru virgulă ceva, nu optzeci și patru de mii de role.
function scrieNumar(v, limba, minZecimale, maxZecimale) {
  return nr(v).toLocaleString(limba === "en" ? "en-GB" : "ro-RO", {
    minimumFractionDigits: minZecimale || 0,
    maximumFractionDigits: maxZecimale === undefined ? 3 : maxZecimale,
  });
}

// Unitățile scrise în română, traduse pentru documentul în engleză. Ce nu e
// aici (PALLET, kg, set) rămâne cum a fost scris. „ml" e metrul liniar, nu
// mililitrul — în engleză ar fi citit greșit, de-aia se traduce și el.
const UM_EN = {
  rola: "roll", "rolă": "roll", role: "rolls",
  buc: "pcs", "buc.": "pcs", "bucăți": "pcs", bucati: "pcs",
  palet: "pallet", paleti: "pallets", "paleți": "pallets",
  tona: "t", "tonă": "t", tone: "t",
  litru: "l", litri: "l",
  ora: "h", "oră": "h", ore: "h",
  mp: "m²", ml: "lin. m",
  cutie: "box", cutii: "boxes", top: "ream", topuri: "reams", seturi: "sets",
};
function umInLimba(um, limba) {
  const t = String(um === null || um === undefined ? "" : um).trim();
  if (limba !== "en" || !t) return t;
  return UM_EN[t.toLowerCase()] || t;
}

// Corpul emailului către furnizor. Text simplu, nu HTML: ajunge întreg și în
// clienții de mail vechi, iar cine îl citește pe telefon nu primește un tabel
// care nu încape pe ecran.
//
// În română sau în engleză (05.11.2026): furnizorii de materie primă sunt și
// afară — prima comandă din ERP a plecat spre WBV, în Germania. Fără `limba`,
// ca înainte, în română.
function corpEmail({ comanda, linii, furnizor, semnatura, limba }) {
  const c = comanda || {};
  const en = limba === "en";
  const limbaEmail = en ? "en" : "ro";
  const randuri = (Array.isArray(linii) ? linii : []).map((l, i) => {
    const cant = scrieNumar(l.cantitate, limbaEmail, 0, 3);
    const um = l.um ? " " + umInLimba(l.um, limbaEmail) : "";
    const v = valoareLinie(l);
    const pret = v === null
      ? (en ? "price to be confirmed" : "preț de confirmat")
      : `${scrieNumar(l.pret_unitar, limbaEmail, 2, 4)} ${c.moneda || "RON"}/${umInLimba(l.um || "buc", limbaEmail)}`;
    return `${i + 1}. ${l.denumire} — ${cant}${um} — ${pret}`;
  });
  const t = totalComanda(linii);
  const suma = scrieNumar(t.total, limbaEmail, 2, 2) + " " + (c.moneda || "RON");
  const parti = [];
  if (en) {
    parti.push(`Dear ${furnizor || "Sir or Madam"},`);
    parti.push("");
    parti.push(`Please find below our purchase order ${c.numar || ""}, dated ${String(c.data || "").slice(0, 10)}.`);
  } else {
    parti.push(`Bună ziua${furnizor ? ", " + furnizor : ""},`);
    parti.push("");
    parti.push(`Vă transmitem comanda ${c.numar || ""}, din data de ${String(c.data || "").slice(0, 10)}.`);
  }
  parti.push("");
  parti.push(randuri.join("\n"));
  parti.push("");
  if (t.faraPret === 0) {
    parti.push(en ? `Order total: ${suma}` : `Total comandă: ${suma}`);
  } else if (en) {
    parti.push(`Total of the items with a price: ${suma} (${t.faraPret} ${t.faraPret === 1 ? "item" : "items"} without a price, please confirm the price)`);
  } else {
    parti.push(`Total pe pozițiile cu preț: ${suma} (${t.faraPret} ${t.faraPret === 1 ? "poziție" : "poziții"} fără preț, vă rugăm să ni-l confirmați)`);
  }
  if (c.data_solicitata) parti.push(`${en ? "Requested delivery date" : "Data de livrare solicitată"}: ${String(c.data_solicitata).slice(0, 10)}`);
  parti.push(orarDescarcare(limbaEmail));
  if (c.observatii) {
    parti.push("");
    parti.push(String(c.observatii));
  }
  parti.push("");
  parti.push(en ? "Please confirm receipt of this order and the delivery date." : "Vă rugăm să confirmați primirea comenzii și termenul de livrare.");
  parti.push("");
  parti.push(semnatura || (en ? "Best regards,\nCash Machine SRL" : "Cu stimă,\nCash Machine SRL"));
  return parti.join("\n");
}

// ---------------------------------------------------------------------------
// MONEDA ȘI CURSUL PUS DE NOI
//
// Cererea lui Vali, 05.11.2026: „Comanda furnizor să poți adăuga moneda și
// schimb la curs pus de noi, să se calculeze și în RON automat și în EUR dacă
// moneda standard e RON."
//
// Pe comandă stau două cursuri, amândouă în lei:
//
//   curs     — câți lei face o unitate din moneda comenzii. La RON nu există
//              (un leu face un leu) și rămâne gol.
//   curs_eur — câți lei face un euro. Din el iese echivalentul în euro al unei
//              comenzi în lei sau în dolari. La o comandă în euro e chiar
//              cursul comenzii, deci se ia acela, ca leii și euro să nu iasă
//              din două cursuri diferite.
//
// CURSUL E AL COMENZII, NU AL ZILEI. Se propune BNR-ul din ziua comenzii, dar
// omul pune ce a negociat cu banca sau cu furnizorul — de-aia „pus de noi". O
// dată scris, rămâne: valoarea în lei a unei comenzi de acum trei luni nu are
// voie să se miște singură când se mișcă euro.

// Un număr tastat într-un câmp: cu virgulă SAU cu punct, cu spații ignorate.
// Gol → { ok: true, valoare: null } („n-a scris nimic"). Ce nu e limpede un
// număr — „1.234,56" (care e separatorul?), „12 buc", „-3" — e refuzat, nu
// ghicit: un preț citit greșit de o mie de ori arată la fel de îngrijit ca
// unul bun. Rotunjit la `zecimale`.
//
// Câmpurile de cantitate și preț sunt text, nu <input type="number">: acela
// nu primește virgula într-un browser pe engleză („0,16" devenea „016"), iar
// pasul lui se numără de la valoarea de pornire și refuza prețuri rotunde.
// Povestea întreagă e în lib/pret-camp.js.
function numarDinCamp(s, zecimale) {
  const t = String(s === null || s === undefined ? "" : s).replace(/\s+/g, "");
  if (t === "") return { ok: true, valoare: null };
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return { ok: false, valoare: null };
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n)) return { ok: false, valoare: null };
  const f = Math.pow(10, zecimale === undefined ? 4 : zecimale);
  return { ok: true, valoare: Math.round(n * f) / f };
}

// Cursul tastat: „5,0912", „5.0912", „ 5,1 ". Gol înseamnă „nu l-am pus"
// (null, și atunci se ia BNR-ul). Orice altceva care nu e un număr pozitiv e o
// greșeală spusă omului, nu un curs ghicit. Până la șase zecimale — BNR dă
// patru, băncile și șase.
function cursDinCamp(s) {
  const r = numarDinCamp(s, 6);
  if (!r.ok) return r;
  if (r.valoare === null) return r;
  if (!(r.valoare > 0)) return { ok: false, valoare: null };
  return r;
}

const pozitiv = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Cursurile cu care se socotește o comandă, curățate: RON are cursul 1, EUR
// are cursul euro egal cu al comenzii, iar ce lipsește rămâne null.
function cursurile(c) {
  const moneda = String((c && c.moneda) || "RON").toUpperCase();
  const curs = moneda === "RON" ? 1 : pozitiv(c && c.curs);
  const cursEur = moneda === "EUR" ? curs : pozitiv(c && c.curs_eur);
  return { moneda, curs, cursEur };
}

// O sumă din moneda comenzii, în lei și în euro.
//
// Unde lipsește cursul lipsește și echivalentul (null), nu se pune zero: un
// „0,00 lei" lângă o comandă de 40.000 € e mai rău decât o liniuță. Euro se
// scoate din leii NEROTUNJIȚI, ca la o comandă în dolari să nu se adune două
// rotunjiri una peste alta.
function echivalente(suma, c) {
  if (suma === null || suma === undefined || suma === "" || !Number.isFinite(Number(suma))) return { ron: null, eur: null };
  const s = Number(suma);
  const { moneda, curs, cursEur } = cursurile(c);
  const ron = curs ? BANI(s * curs) : null;
  let eur = null;
  if (moneda === "EUR") eur = BANI(s);
  else if (curs && cursEur) eur = BANI((s * curs) / cursEur);
  return { ron, eur };
}

// Cursul scris pentru om: patru zecimale ca la BNR, șase dacă așa l-a pus
// cineva — „5,0912", nu „5,09" și nici „5,091200".
function scrieCurs(v) {
  const n = pozitiv(v);
  if (n === null) return "";
  const cuSase = Math.round(n * 1e6) / 1e6;
  const zecimale = Math.abs(Math.round(cuSase * 1e4) / 1e4 - cuSase) > 1e-12 ? 6 : 4;
  return cuSase.toLocaleString("ro-RO", { minimumFractionDigits: zecimale, maximumFractionDigits: zecimale });
}

// Cu cât diferă cursul pus de noi de BNR, în procente. Null când nu se poate
// spune. Pagina îl arată lângă curs: 5,0912 tastat 50,912 iese +900% și se
// vede, înainte să plece comanda.
function abatereFataDeBnr(curs, bnr) {
  const a = pozitiv(curs);
  const b = pozitiv(bnr);
  if (a === null || b === null) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// ISTORICUL: ce s-a schimbat pe o comandă, când și de cine.
//
// „Dacă se modifică ceva rămâne în istoric cine a modificat ce și când"
// (Vali, 05.11.2026). Aici e doar comparația, fără bază de date, ca să poată
// fi verificată: dacă istoricul pierde o schimbare, nu se vede niciodată.

const textCurat = (v) => (v === null || v === undefined ? "" : String(v).trim());

function cantText(v) {
  return nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
}
function pretText(v, moneda) {
  if (v === null || v === undefined || v === "") return "fără preț";
  return Number(v).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + (moneda ? " " + moneda : "");
}

// Prețul lipsă și prețul zero NU sunt la fel: unul e „de confirmat", celălalt
// e gratis. Restul se compară ca numere, nu ca text — „1.5" din formular și
// 1,5 din bază sunt același preț, iar o comparație pe text ar umple istoricul
// cu schimbări care nu s-au întâmplat.
function acelasiNumar(a, b) {
  const golA = a === null || a === undefined || a === "";
  const golB = b === null || b === undefined || b === "";
  if (golA || golB) return golA === golB;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

// Capul comenzii. `vechi` și `nou` au aceeași formă: { furnizor (numele),
// data, data_solicitata, moneda, curs, curs_eur, observatii }.
//
// Cursul se scrie cu moneda lui („5,0912 lei/EUR"): dacă moneda comenzii se
// schimbă din USD în GBP, același număr înseamnă altceva, iar istoricul
// trebuie să arate asta.
function diferenteAntet(vechi, nou) {
  const v = vechi || {};
  const n = nou || {};
  const out = [];
  const camp = (ce, a, b) => {
    if (textCurat(a) === textCurat(b)) return;
    out.push({ ce, vechi: textCurat(a), nou: textCurat(b) });
  };
  camp("Furnizor", v.furnizor, n.furnizor);
  camp("Data comenzii", String(v.data || "").slice(0, 10), String(n.data || "").slice(0, 10));
  camp("Data solicitată", String(v.data_solicitata || "").slice(0, 10), String(n.data_solicitata || "").slice(0, 10));
  camp("Moneda", String(v.moneda || "RON").toUpperCase(), String(n.moneda || "RON").toUpperCase());

  const cv = cursurile(v);
  const cn = cursurile(n);
  const cursScris = (c) => (c.moneda === "RON" || !c.curs ? "" : scrieCurs(c.curs) + " lei/" + c.moneda);
  camp("Curs", cursScris(cv), cursScris(cn));
  // Cursul euro separat doar unde nu e chiar cursul comenzii: la o comandă
  // în euro e același număr, și ar ieși în istoric de două ori.
  const eurScris = (c) => (c.moneda === "EUR" || !c.cursEur ? "" : scrieCurs(c.cursEur) + " lei/EUR");
  camp("Curs EUR", eurScris(cv), eurScris(cn));

  camp("Observații", v.observatii, n.observatii);
  return out;
}

// Pozițiile, comparate pe ID-ul liniei — nu pe ordine, nu pe produs.
//
// Pe ordine, ștergerea liniei a doua ar scrie trei schimbări acolo unde s-a
// întâmplat una. Pe produs nu se poate: la materie primă jumătate din linii
// n-au produs în nomenclator, doar o denumire scrisă de mână.
//
// `vechi`: liniile din bază ({ id, denumire, cantitate, um, pret_unitar });
// `nou`: ce a rămas după formular — liniile păstrate au `id`, cele adăugate
// n-au. Ce lipsește din `nou` a fost șters.
function diferenteLinii(vechi, nou, moneda) {
  const out = [];
  const m = moneda ? String(moneda).toUpperCase() : "";
  const descrie = (l) => `${textCurat(l.denumire)} — ${cantText(l.cantitate)}${l.um ? " " + textCurat(l.um) : ""} × ${pretText(l.pret_unitar, m)}`;
  const dupaId = new Map((Array.isArray(vechi) ? vechi : []).map((l) => [String(l.id), l]));
  const ramase = new Set();
  for (const l of Array.isArray(nou) ? nou : []) {
    const v = l && l.id !== null && l.id !== undefined && l.id !== "" ? dupaId.get(String(l.id)) : null;
    if (!v) {
      out.push({ ce: "Poziție adăugată", vechi: "", nou: descrie(l) });
      continue;
    }
    ramase.add(String(v.id));
    const nume = textCurat(l.denumire) || textCurat(v.denumire);
    if (textCurat(v.denumire) !== textCurat(l.denumire)) out.push({ ce: "Denumire poziție", vechi: textCurat(v.denumire), nou: textCurat(l.denumire) });
    if (!acelasiNumar(v.cantitate, l.cantitate)) out.push({ ce: "Cantitate · " + nume, vechi: cantText(v.cantitate), nou: cantText(l.cantitate) });
    if (textCurat(v.um) !== textCurat(l.um)) out.push({ ce: "UM · " + nume, vechi: textCurat(v.um), nou: textCurat(l.um) });
    if (!acelasiNumar(v.pret_unitar, l.pret_unitar)) out.push({ ce: "Preț unitar · " + nume, vechi: pretText(v.pret_unitar, m), nou: pretText(l.pret_unitar, m) });
  }
  for (const [id, v] of dupaId) {
    if (!ramase.has(id)) out.push({ ce: "Poziție ștearsă", vechi: descrie(v), nou: "" });
  }
  return out;
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
  ORAR_DESCARCARE,
  orarDescarcare,
  limbaImplicita,
  scrieNumar,
  umInLimba,
  numarDinCamp,
  cursDinCamp,
  cursurile,
  echivalente,
  scrieCurs,
  abatereFataDeBnr,
  acelasiNumar,
  diferenteAntet,
  diferenteLinii,
};
