// Client de integrare cu API-ul SmartBill (facturare + gestiune).
//
// ⚠️ IMPORTANT — DE VERIFICAT ÎNAINTE DE PRIMA UTILIZARE REALĂ:
// Accesul la documentația tehnică completă (endpoint-uri exacte, câmpuri
// JSON) se obține abia după ce SmartBill aprobă cererea de API (trimisă la
// vreauapi@smartbill.ro, necesită abonament Facturare Platinum / Gestiune
// Plus). Structura de mai jos e construită pe baza tiparului public,
// documentat, al API-ului SmartBill (autentificare Basic Auth cu emailul
// contului + un token API, endpoint POST /invoice pentru emitere factură),
// dar NU a fost testată împotriva contului tău real. Primul test se face
// din interfața ERP, pe factura reală — dacă apare o eroare de la SmartBill
// (ex: câmp lipsă/nume greșit), ajustăm rapid maparea din `construiesteFactura`
// mai jos, comparând cu documentația completă primită de la SmartBill.
"use strict";

const BASE_URL = process.env.SMARTBILL_API_BASE || "https://ws.smartbill.ro/SBORO/api";

function isConfigured() {
  return Boolean(process.env.SMARTBILL_EMAIL && process.env.SMARTBILL_TOKEN && process.env.SMARTBILL_CIF);
}

function authHeader() {
  const token = Buffer.from(`${process.env.SMARTBILL_EMAIL}:${process.env.SMARTBILL_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

// Limită documentată: 3 apeluri/secundă. Păstrăm un interval minim simplu
// între apeluri, ca să nu riscăm blocarea temporară de 10 minute.
let ultimulApel = 0;
async function limiteazaRitmul() {
  const minIntervalMs = 350;
  const asteapta = ultimulApel + minIntervalMs - Date.now();
  if (asteapta > 0) await new Promise((r) => setTimeout(r, asteapta));
  ultimulApel = Date.now();
}

async function apelApi(path, method, body) {
  if (!isConfigured()) {
    throw new Error(
      "Integrarea SmartBill nu este configurată. Setează variabilele de mediu SMARTBILL_EMAIL, SMARTBILL_TOKEN și SMARTBILL_CIF."
    );
  }
  await limiteazaRitmul();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const mesaj = json.errorText || json.message || text || `HTTP ${res.status}`;
    throw new Error(`SmartBill a răspuns cu eroare (${res.status}): ${mesaj}`);
  }
  return json;
}

// Factura, în forma cerută de SmartBill.
//
// `adresa` = { tara, judet, localitate }, pregătită de lib/adresa-client.js.
// Fără ea SmartBill refuza factura cu „(400) țara trebuie specificată" —
// primul test real, pe FCT-1, 29.10.2026. Câmpurile clientului au numele
// din API-ul SmartBill: country, county, city.
//
// Tot atunci s-au reparat două lucruri care nu dădeau eroare, dar ieșeau
// greșit pe factură:
//   • moneda nu se trimitea deloc. O factură în euro ar fi plecat ca factură
//     în lei, cu sumele în euro — de cinci ori mai mică.
//   • unitatea de măsură era „buc" pe orice linie, inclusiv pe folia
//     facturată la kilogram. Acum vine din produs, iar „buc" rămâne doar când
//     produsul nu spune altceva.
function construiesteFactura(factura, linii, adresa) {
  const a = adresa || {};
  const moneda = String(factura.moneda || "RON").toUpperCase();
  return {
    companyVatCode: process.env.SMARTBILL_CIF,
    client: {
      name: factura.partener_nume,
      vatCode: factura.cui || undefined,
      address: factura.adresa || undefined,
      isTaxPayer: Boolean(factura.cui),
      city: a.localitate || undefined,
      county: a.judet || undefined,
      country: a.tara || undefined,
      email: factura.email || undefined,
      saveToDb: false,
    },
    seriesName: process.env.SMARTBILL_SERIE || undefined,
    issueDate: (factura.data_emiterii || "").slice(0, 10) || undefined,
    dueDate: factura.data_scadenta || undefined,
    currency: moneda,
    products: linii.map((l) => ({
      name: l.denumire,
      quantity: l.cantitate,
      price: l.pret_unitar,
      measuringUnitName: String(l.unitate_masura || "").trim() || "buc",
      currency: moneda,
      taxName: "Normala",
      taxPercentage: l.cota_tva,
      isTaxIncluded: false,
      saveToDb: false,
    })),
  };
}

async function trimiteFactura(factura, linii, adresa) {
  const payload = construiesteFactura(factura, linii, adresa);
  const rezultat = await apelApi("/invoice", "POST", payload);
  return {
    series: rezultat.series || payload.seriesName,
    number: rezultat.number,
    raw: rezultat,
  };
}

async function interogheazaStoc(numeDepozit) {
  const params = new URLSearchParams({ cif: process.env.SMARTBILL_CIF, warehouseName: numeDepozit || "" });
  return apelApi(`/stocks?${params.toString()}`, "GET");
}

module.exports = { isConfigured, trimiteFactura, interogheazaStoc, construiesteFactura };
