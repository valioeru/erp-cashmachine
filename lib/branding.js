"use strict";
// Brandingul comenzii: produsele pleacă cu branding Cash Machine sau
// nepersonalizate.
//
// Vali, 09.11.2026: „La toate produsele din comenzi, sau mai bine spus la
// comenzi, să se aleagă și cu branding Cash Machine sau nepersonalizate."
//
// E o alegere pe comandă, nu pe linie („mai bine spus la comenzi"), și se
// cere la fel ca livrarea parțială (lib/livrare-partiala.js): obligatoriu la
// comanda nouă și la modificare, verificată și pe server, nu doar în formular.
// Producția și depozitul o văd pe comanda lor, ca să știe ce imprimă și ce
// pun pe palet.
//
// Comenzile născute altfel (din ofertă, din calculator, comanda zilei
// Sameday, cele citite din email) n-au răspunsul: rămân „nespecificat" până
// le modifică cineva — atunci se cere.

const VALORI = {
  cash_machine: "cu branding Cash Machine",
  nepersonalizat: "nepersonalizate",
};

// Ce a venit din formular, curățat: o valoare din listă sau null.
function valid(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(VALORI, s) ? s : null;
}

function text(comanda) {
  const v = valid(comanda && comanda.branding);
  return v ? VALORI[v] : "nespecificat";
}

// Eticheta mică de pe pagini: verde pentru Cash Machine, gri pentru
// nepersonalizat, galben pentru nespecificat (lipsește un răspuns).
function eticheta(comanda) {
  const v = valid(comanda && comanda.branding);
  const culoare = v === "cash_machine" ? "verde" : v === "nepersonalizat" ? "gri" : "galben";
  return `<span class="badge ${culoare}">${text(comanda)}</span>`;
}

module.exports = { VALORI, valid, text, eticheta };
