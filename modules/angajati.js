"use strict";
const { registerCrud } = require("../lib/crud");
const { money } = require("../lib/render");

function register(router) {
  registerCrud(router, {
    path: "/angajati",
    table: "angajati",
    title: "Angajați",
    singular: "angajat",
    fields: [
      { name: "nume", label: "Nume complet", required: true },
      { name: "functie", label: "Funcție" },
      { name: "departament", label: "Departament" },
      { name: "email", label: "Email", type: "email" },
      { name: "telefon", label: "Telefon" },
      { name: "data_angajarii", label: "Data angajării", type: "date" },
      { name: "salariu_baza", label: "Salariu de bază brut (lei)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "nume", label: "Nume" },
      { key: "functie", label: "Funcție" },
      { key: "departament", label: "Departament" },
      { key: "salariu_baza", label: "Salariu brut", render: (r) => money(r.salariu_baza) },
    ],
  });
}

module.exports = { register };
