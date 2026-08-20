"use strict";
const { registerCrud } = require("../lib/crud");
const { money } = require("../lib/render");

function register(router) {
  registerCrud(router, {
    path: "/produse",
    table: "produse",
    title: "Produse",
    singular: "produs",
    fields: [
      { name: "cod", label: "Cod produs" },
      { name: "denumire", label: "Denumire", required: true },
      { name: "unitate_masura", label: "Unitate de măsură", default: "buc" },
      { name: "pret_vanzare", label: "Preț vânzare (fără TVA)", type: "number", step: "0.01", default: 0 },
      { name: "pret_achizitie", label: "Preț achiziție", type: "number", step: "0.01", default: 0 },
      { name: "cota_tva", label: "Cotă TVA (%)", type: "number", step: "0.01", default: 19 },
      { name: "stoc_minim", label: "Stoc minim (alertă)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "cod", label: "Cod" },
      { key: "denumire", label: "Denumire" },
      { key: "unitate_masura", label: "UM" },
      { key: "pret_vanzare", label: "Preț vânzare", render: (r) => money(r.pret_vanzare) },
      { key: "cota_tva", label: "TVA", render: (r) => `${r.cota_tva}%` },
    ],
  });
}

module.exports = { register };
