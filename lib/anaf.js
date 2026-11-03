"use strict";
// Datele unei firme de la ANAF, după CUI: denumirea, Nr. Reg. Com., adresa.
//
// CEREREA LUI VALI, 03.11.2026: „Fă și Reg. Com. pe client și urcă tot din
// SmartBill, dacă poți — să fie și ăla, inclusiv pentru facturi.”
//
// De ce de la ANAF și nu din SmartBill: API-ul SmartBill n-are nicio cerere
// care să întoarcă lista de clienți (are facturi, proforme, plăți, stocuri) —
// clienții din ERP au venit din exporturi Excel, fără coloana de Reg. Com.
// ANAF e oricum sursa oficială, aceeași din care își ia SmartBill datele când
// completezi un client după CUI.
//
// Serviciul public „PlatitorTvaRest” v9 (documentația ANAF, doc_WS_V9):
//   POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
//   corp: [{ "cui": 27244210, "data": "2026-11-03" }, …] — cel mult 100 de CUI
//   o cerere pe secundă; „orice tentativă de suprasolicitare va fi pedepsită”.
//   răspuns: { found: [{ date_generale: { cui, denumire, nrRegCom, adresa, … },
//              adresa_sediu_social: { sdenumire_Judet, sdenumire_Localitate, … } }],
//              notFound: [cui, …] }
// Verificat pe 03.11.2026: Cash Machine → J2010002107232, Depanero →
// J2012008016408 (exact cum scrie pe avizul din SmartBill).
const URL_ANAF = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";
const PE_CERERE = 100;
const PAUZA_MS = 1100;

// CUI-ul românesc ca număr: „RO27244210”, „ro 27244210”, „27244210” → 27244210.
// Un cod străin („DE123…”, „ATU…”) sau o adresă de email scrisă greșit în
// câmpul de CUI nu e întrebat la ANAF: n-are ce găsi acolo.
function cuiNumeric(cui) {
  const s = String(cui == null ? "" : cui).trim().toUpperCase().replace(/\s+/g, "").replace(/^RO/, "");
  if (!/^\d{2,10}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

const asteapta = (ms) => new Promise((r) => setTimeout(r, ms));

// Întreabă ANAF de toate CUI-urile, câte 100, cu o secundă între cereri.
// Întoarce Map(cui numeric → { cui, denumire, nrRegCom, adresa, judet, localitate })
// plus lista celor negăsite. O cerere căzută oprește tot și spune de ce: mai
// bine nimic scris decât jumătate scris fără să știe nimeni.
async function cauta(cuiuri, optiuni) {
  const o = optiuni || {};
  const fetchFn = o.fetchFn || fetch;
  const pauza = o.pauzaMs === undefined ? PAUZA_MS : o.pauzaMs;
  const data = o.data || new Date().toISOString().slice(0, 10);
  const unice = [...new Set((cuiuri || []).map(cuiNumeric).filter(Boolean))];
  const gasite = new Map();
  const negasite = [];
  for (let i = 0; i < unice.length; i += PE_CERERE) {
    if (i > 0 && pauza > 0) await asteapta(pauza);
    const bucata = unice.slice(i, i + PE_CERERE);
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const ceas = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs || 30000) : null;
    let r;
    try {
      r = await fetchFn(URL_ANAF, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bucata.map((cui) => ({ cui, data }))),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new Error("ANAF nu răspunde: " + (e && e.name === "AbortError" ? "a trecut timpul de așteptare" : e.message));
    } finally {
      if (ceas) clearTimeout(ceas);
    }
    if (!r.ok) throw new Error(`ANAF a răspuns cu ${r.status}. Încearcă din nou peste câteva minute.`);
    let corp;
    try {
      corp = await r.json();
    } catch (e) {
      throw new Error("ANAF a răspuns cu ceva ce nu e JSON.");
    }
    for (const f of (corp && corp.found) || []) {
      const g = (f && f.date_generale) || {};
      const a = (f && f.adresa_sediu_social) || {};
      const cui = Number(g.cui);
      if (!cui) continue;
      gasite.set(cui, {
        cui,
        denumire: String(g.denumire || "").trim(),
        nrRegCom: String(g.nrRegCom || "").trim(),
        adresa: String(g.adresa || "").trim(),
        judet: String(a.sdenumire_Judet || "").trim(),
        localitate: String(a.sdenumire_Localitate || "").trim(),
      });
    }
    for (const x of (corp && corp.notFound) || []) negasite.push(Number(x && x.cui !== undefined ? x.cui : x));
  }
  return { gasite, negasite };
}

module.exports = { URL_ANAF, PE_CERERE, cuiNumeric, cauta };
