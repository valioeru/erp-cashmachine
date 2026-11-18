"use strict";
// Ordinea în care se citesc comenzile, după stadiu. Fără bază de date.
//
// Vali, 18.11.2026: „La comenzi, implicit, cele noi apar sus ca sortare, apoi
// cele care așteaptă marfă, apoi în producție, apoi în stoc depozit, apoi
// facturată, apoi livrată și anulată." Stadiile pe care nu le-a numit stau
// lângă vecinul lor din flux (confirmată după nouă, gata de livrare după stoc
// depozit, în livrare după facturată).
//
// O singură listă, folosită și de lista de comenzi, și de raportul „Comenzi pe
// status": aceeași ordine peste tot.
const ORDINE = [
  "noua", "confirmata", "asteapta_marfa", "in_productie", "productie_finalizata",
  "in_stoc_depozit", "gata_livrare", "facturata", "in_livrare", "livrata_partial", "livrata", "anulata",
];
const LOC = new Map(ORDINE.map((s, i) => [s, i]));
// Locul unui stadiu; cele necunoscute vin la urmă, înaintea nimănui.
const rang = (status) => (LOC.has(String(status || "")) ? LOC.get(String(status)) : ORDINE.length);
// În SQL: CASE-ul care dă același loc. `col` = coloana cu statusul.
const sqlRang = (col) => `CASE ${col} ${ORDINE.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} ELSE ${ORDINE.length} END`;

// Raportul „Comenzi pe status": rândurile din bază, adunate pe stadiu și pe agent.
//   randuri: [{ status, agent, nr, valoare, fara_curs }] — câte un rând pe (stadiu, agent)
// Întoarce { peStatus, peAgent, stari, total } cu stadiile în ordinea de mai sus
// și agenții de la cea mai mare valoare în jos.
function aduna(randuri) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const peStatus = new Map();
  const peAgent = new Map();
  const total = { nr: 0, valoare: 0, faraCurs: 0 };
  for (const r of randuri || []) {
    const st = String(r.status || "");
    const ag = String(r.agent || "").trim() || "fără agent";
    const nr = n(r.nr);
    const val = n(r.valoare);
    if (!peStatus.has(st)) peStatus.set(st, { status: st, nr: 0, valoare: 0 });
    const s = peStatus.get(st);
    s.nr += nr;
    s.valoare += val;
    if (!peAgent.has(ag)) peAgent.set(ag, { agent: ag, nr: 0, valoare: 0, peStatus: {} });
    const a = peAgent.get(ag);
    a.nr += nr;
    a.valoare += val;
    if (!a.peStatus[st]) a.peStatus[st] = { nr: 0, valoare: 0 };
    a.peStatus[st].nr += nr;
    a.peStatus[st].valoare += val;
    total.nr += nr;
    total.valoare += val;
    total.faraCurs += n(r.fara_curs);
  }
  const stari = [...peStatus.values()].sort((x, y) => rang(x.status) - rang(y.status) || x.status.localeCompare(y.status));
  for (const s of stari) s.parte = total.valoare > 0 ? s.valoare / total.valoare : 0;
  const agenti = [...peAgent.values()].sort((x, y) => y.valoare - x.valoare || y.nr - x.nr || x.agent.localeCompare(y.agent, "ro"));
  for (const a of agenti) a.parte = total.valoare > 0 ? a.valoare / total.valoare : 0;
  return { peStatus: stari, peAgent: agenti, stari: stari.map((s) => s.status), total };
}

module.exports = { ORDINE, rang, sqlRang, aduna };
