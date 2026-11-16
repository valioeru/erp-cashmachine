"use strict";
// Unitatea de măsură a unei cereri de aprovizionare (depozit → producție sau
// terț).
//
// CE A CERUT VALI, 16.11.2026, cu poza comenzii #107:
//   „Dacă a cerut kg, în comandă de ce apare în producție 160 rolă?"
//   „Ar trebui corectat aici."
//
// DE CE SE ÎNTÂMPLA:
//   Clientul comandă într-o unitate aleasă pe linia comenzii (kg, rolă, buc),
//   care poate fi alta decât unitatea produsului din nomenclator. Depozitul
//   cere de la producție cât lipsește din linie, deci în unitatea liniei. Dar
//   cererea nu-și ținea unitatea: lista producției, comanda de producție făcută
//   la confirmare și paleții puși din cerere luau unitatea din nomenclator.
//   La #107: 160 kg au ajuns „160 rola" pe comanda de producție.
//
// REGULA: unitatea cererii e cea scrisă pe cerere (de la 16.11.2026 se scrie
// la emitere); la cererile mai vechi, a liniei din comanda clientului pentru
// care s-a cerut; abia la urmă a produsului din nomenclator.

const text = (v) => (v == null ? "" : String(v).trim());

// Pentru interogări: `a` = aprovizionari, `p` = produse. Se pune JOIN_UM în
// FROM și SQL_UM în SELECT.
const JOIN_UM = "LEFT JOIN comenzi_linii clu ON clu.id = a.linie_id";
const SQL_UM = "COALESCE(NULLIF(TRIM(a.um), ''), NULLIF(TRIM(clu.um), ''), p.unitate_masura)";

// Același lucru, în cod: cererea, linia comenzii clientului, produsul.
function umCerere(cerere, linie, produs) {
  return text(cerere && cerere.um) || text(linie && linie.um) || text(produs && produs.unitate_masura) || "buc";
}

module.exports = { JOIN_UM, SQL_UM, umCerere };
