"use strict";
// Scoate „SC" din fața numelor de parteneri, o singură dată.
//
// De ce la pornire și nu printr-un UPDATE: baza de pe Render nu e accesibilă
// din afară (lista de IP-uri e goală), deci singurul loc de unde se poate
// scrie e aplicația însăși.
//
// REGULA: se atinge DOAR numele afișat. CUI-ul, care e cheia adevărată, nu.
// Iar potrivirile pe nume (importul de facturi) trec de acum printr-o cheie
// care ignoră prefixul în ambele sensuri — altfel factura de luna viitoare,
// care vine tot cu „SC AQUILA SRL", n-ar mai găsi partenerul „Aquila SRL" și
// ar crea un duplicat. Vezi lib/nume-firma.js.
//
// Rulează la fiecare pornire, dar a doua oară nu mai are ce schimba: după
// tăiere, numele nu mai începe cu „SC".
const db = require("./db");
const NF = require("./nume-firma");

async function curata() {
  let randuri;
  try {
    randuri = await db.prepare("SELECT id, nume FROM parteneri WHERE nume IS NOT NULL").all();
  } catch (e) {
    return { schimbate: 0 };
  }
  let schimbate = 0;
  for (const p of randuri) {
    if (!NF.areSC(p.nume)) continue;
    const nou = NF.faraSC(p.nume);
    if (!nou || nou === p.nume) continue;
    // Daca taierea ar duce la un nume care exista deja la ALT partener, nu
    // se atinge: doua randuri cu acelasi nume sunt mai greu de dezlegat
    // decat un „SC" in plus, iar fuziunea partenerilor e o decizie de om.
    const ciocnire = await db
      .prepare("SELECT id FROM parteneri WHERE lower(nume) = lower(?) AND id <> ? LIMIT 1")
      .get(nou, p.id);
    if (ciocnire) continue;
    await db.prepare("UPDATE parteneri SET nume = ? WHERE id = ?").run(nou, p.id);
    schimbate++;
  }
  if (schimbate) console.log("[parteneri] am scos „SC" din fata a " + schimbate + " nume");
  return { schimbate };
}

module.exports = { curata };
