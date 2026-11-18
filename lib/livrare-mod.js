"use strict";
// Cum se face livrarea unei comenzi. Fără bază de date.
//
// Vali, 18.11.2026: „La comanda nouă se alege și cum să se facă livrarea, cu
// variantele: livrează agentul de vânzări, ridică clientul, trimitem noi cu
// transport intern, trimitem noi cu transportator terț."
//
// Se alege la plasare (obligatoriu), se poate schimba la modificare și se vede
// pe comandă și în lista depozitului. Comenzile de dinainte n-au nimic ales:
// la ele scrie „nespecificat" și nu se cere nimic până nu le modifică cineva.
const OPTIUNI = [
  ["agent", "Livrează agentul de vânzări"],
  ["client", "Ridică clientul"],
  ["intern", "Trimitem noi, cu transport intern"],
  ["tert", "Trimitem noi, cu transportator terț"],
];
const TEXT = new Map(OPTIUNI);

// Ce a venit din formular: cheia, dacă e una din cele patru; altfel "".
const valid = (v) => (TEXT.has(String(v == null ? "" : v).trim()) ? String(v).trim() : "");
// Cum se scrie pe pagină și în istoric.
const text = (doc) => TEXT.get(valid(doc && doc.livrare_mod)) || "nespecificat";

module.exports = { OPTIUNI, valid, text };
