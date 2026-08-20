"use strict";
const { registerCrud } = require("../lib/crud");
const { esc } = require("../lib/render");

const TIP_LABEL = { client: "Client", furnizor: "Furnizor", ambele: "Client & Furnizor" };

function register(router) {
  registerCrud(router, {
    path: "/parteneri",
    table: "parteneri",
    title: "Parteneri (clienți & furnizori)",
    singular: "partener",
    fields: [
      {
        name: "tip",
        label: "Tip",
        type: "select",
        required: true,
        default: "client",
        options: [
          { value: "client", label: "Client" },
          { value: "furnizor", label: "Furnizor" },
          { value: "ambele", label: "Client & Furnizor" },
        ],
      },
      { name: "nume", label: "Nume / denumire firmă", required: true },
      { name: "cui", label: "CUI / CIF" },
      { name: "email", label: "Email", type: "email" },
      { name: "telefon", label: "Telefon" },
      { name: "adresa", label: "Adresă", type: "textarea" },
    ],
    listColumns: [
      { key: "nume", label: "Nume" },
      { key: "tip", label: "Tip", render: (r) => TIP_LABEL[r.tip] || esc(r.tip) },
      { key: "cui", label: "CUI" },
      { key: "email", label: "Email" },
      { key: "telefon", label: "Telefon" },
    ],
  });
}

module.exports = { register, TIP_LABEL };
