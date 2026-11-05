"use strict";
// Cum ajunge marfa la client, când nu o duce un transportator din clasament.
//
// Cererea lui Vali, 05.11.2026: „La logistică trebuie să fie și varianta
// preluare de către client, sau distribuită de agentul de vânzări, sau
// livrare cu camion propriu sau cu dubă mică sau altă modalitate" · „Altă
// modalitate: scrie care e, liber."
//
// Până acum o cursă se putea închide doar alocând-o unui transportator din
// clasament. Marfa ridicată de client din rampă sau dusă de agent cu mașina
// lui rămânea „de alocat" la nesfârșit — și coada logisticii nu mai spunea
// adevărul. Aici e doar regula (pură, cu test): ce variante sunt, ce cere
// fiecare și cum se scrie pe ecran.

const MODALITATI = [
  ["client", "Ridicată de client"],
  ["agent", "Distribuită de agentul de vânzări"],
  ["camion", "Camion propriu"],
  ["duba", "Dubă mică"],
  ["alta", "Altă modalitate"],
];
const ETICHETE = Object.fromEntries(MODALITATI);

const curat = (v, max) => {
  const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max || 200) : "";
};

// Ce s-a ales în formular, verificat. `agenti` = lista celor care pot duce
// marfa ca agenți ({ id, nume }), ca un id trimis de mână să nu treacă.
function citeste(b, agenti) {
  const o = b || {};
  const modalitate = String(o.modalitate || "").trim();
  if (!ETICHETE[modalitate]) return { ok: false, eroare: "Alege cum ajunge marfa la client." };
  const textLiber = curat(o.modalitate_text, 200);
  const vehicul = curat(o.vehicul, 80);
  let agentId = null;
  if (modalitate === "agent") {
    agentId = parseInt(o.agent_id, 10) || null;
    if (!agentId || !(agenti || []).some((a) => Number(a.id) === agentId)) {
      return { ok: false, eroare: "Alege agentul de vânzări care duce marfa." };
    }
  }
  if (modalitate === "alta" && !textLiber) {
    return { ok: false, eroare: "La „altă modalitate” scrie care e (ex. curier rapid, transport al furnizorului)." };
  }
  const cost = curat(o.cost, 20).replace(",", ".");
  const n = cost === "" ? null : Number(cost);
  if (cost !== "" && !(Number.isFinite(n) && n >= 0)) return { ok: false, eroare: `Costul „${o.cost}” nu e un număr.` };
  return {
    ok: true,
    modalitate,
    modalitate_text: modalitate === "alta" ? textLiber : textLiber || null,
    agent_id: agentId,
    vehicul: vehicul || null,
    cost: n,
  };
}

// Cum se scrie pe ecran: „Ridicată de client", „Agent: Ion Popescu",
// „Altă modalitate: curier rapid", „Camion propriu · B 123 ABC".
function eticheta(c, numeAgent) {
  const m = c && c.modalitate;
  if (!m || !ETICHETE[m]) return "";
  let t = m === "agent" ? `Agent: ${numeAgent || "—"}` : m === "alta" ? `Altă modalitate: ${c.modalitate_text || "—"}` : ETICHETE[m];
  if (c.vehicul) t += ` · ${c.vehicul}`;
  return t;
}

// Ridicarea de către client nu are „pe drum": marfa pleacă din rampă cu el.
const arePeDrum = (c) => !(c && c.modalitate === "client");

module.exports = { MODALITATI, ETICHETE, citeste, eticheta, arePeDrum };
