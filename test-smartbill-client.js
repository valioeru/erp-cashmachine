"use strict";
// Factura trimisă în SmartBill: țara, județul și localitatea clientului.
//
// CE S-A ÎNTÂMPLAT, 29.10.2026: FCT-1 către Ding Communication n-a plecat —
// „SmartBill a răspuns cu eroare (400): țara trebuie specificată". ERP-ul
// trimitea clientul doar cu nume, CUI și adresa ca un singur șir.
//
// Testul rulează cererea până la ușa SmartBill: `fetch` e prins, ca să se
// vadă exact ce JSON ar pleca, fără să plece nimic.

const assert = require("assert");
const Module = require("module");
const ADR = require("./lib/adresa-client");

let treceri = 0;
async function test(nume, f) {
  await f();
  treceri++;
  console.log("  ok —", nume);
}

(async () => {
  // ---- citirea adresei ------------------------------------------------------

  await test("tiparul SmartBill din adresă dă localitatea, județul și țara", async () => {
    const r = ADR.dinAdresa("Str. Sat Dobridor Com. Motatei, Str. Grefierului, Nr.2, Loc.Dobridor, Jud. Dolj, Tara Romania");
    assert.deepStrictEqual(r, { localitate: "Dobridor", judet: "Dolj", tara: "Romania" });
  });

  await test("la București localitatea e sectorul, oricum ar fi scris", async () => {
    assert.strictEqual(ADR.dinAdresa("Str Gara Herastrau, Nr.6, Loc.Sector 2, Jud. Bucuresti, Tara Romania").localitate, "Sector 2");
    assert.strictEqual(ADR.dinAdresa("Str. Bucovina, Nr.1bis, Sector 3, Loc.Bucuresti, Jud. Bucuresti, Tara Romania").localitate, "Sector 3");
  });

  await test("județul se recunoaște cu sau fără diacritice, și nu se aproximează", async () => {
    assert.strictEqual(ADR.judetCanonic("Jud. Dâmbovița"), "Dambovita");
    assert.strictEqual(ADR.judetCanonic("Bistrița-Năsăud"), "Bistrita-Nasaud");
    assert.strictEqual(ADR.judetCanonic("Municipiul Bucuresti"), "Bucuresti");
    assert.strictEqual(ADR.judetCanonic("Ilfovv"), "", "un județ aproape-bun e tot unul greșit");
    assert.strictEqual(ADR.JUDETE.length, 42, "41 de județe și Bucureștiul");
  });

  await test("țara se scrie ca în SmartBill", async () => {
    for (const t of ["România", "ROMANIA", "RO", "rou"]) assert.strictEqual(ADR.taraCanonica(t), "Romania");
    assert.strictEqual(ADR.taraCanonica("Grecia"), "Grecia");
  });

  await test("client importat din SmartBill: totul e sigur, pleacă direct", async () => {
    const r = ADR.pentruSmartBill({ cui: "RO27078460", adresa: "…, Loc.Dobridor, Jud. Dolj, Tara Romania" });
    assert.strictEqual(r.sigur, true);
    assert.deepStrictEqual([r.tara, r.judet, r.localitate], ["Romania", "Dolj", "Dobridor"]);
  });

  await test("client fără adresă: nu se ghicește nimic, se cere", async () => {
    const r = ADR.pentruSmartBill({ cui: "RO35674765", adresa: "" });
    assert.strictEqual(r.sigur, false);
    assert.strictEqual(r.tara, "Romania", "CUI românesc → firmă din România, asta se știe");
    assert.deepStrictEqual(r.lipsa, ["județul", "localitatea"]);
  });

  await test("adresă scrisă de mână: nu se trage concluzia din ea", async () => {
    const r = ADR.pentruSmartBill({ cui: "", adresa: "Str. Buiacului 2 CORP A Cod 077135 (UNITATEA A1), Mogosoaia" });
    assert.strictEqual(r.sigur, false);
  });

  await test("client străin: țara se deduce din codul de TVA, dar se confirmă", async () => {
    const r = ADR.pentruSmartBill({ cui: "NL815140952B01", adresa: "" });
    assert.strictEqual(r.tara, "Olanda");
    assert.strictEqual(r.sigur, false, "o țară dedusă nu pleacă pe factură fără să o vadă cineva");
    assert.ok(!r.lipsa.includes("județul"), "județul se cere doar în România");
  });

  await test("ce e scris în fișa clientului bate ce se citește din adresă", async () => {
    const r = ADR.pentruSmartBill({ cui: "RO1", adresa: "…, Loc.Dobridor, Jud. Dolj, Tara Romania", tara: "Romania", judet: "Ilfov", localitate: "Voluntari" });
    assert.deepStrictEqual([r.judet, r.localitate], ["Ilfov", "Voluntari"]);
    assert.deepStrictEqual(r.deScrisInFisa, {}, "nu se rescrie fișa cu ce s-a citit din adresă");
  });

  await test("formularul de confirmare cere județ din listă pentru România", async () => {
    assert.strictEqual(ADR.verifica({ tara: "Romania", judet: "", localitate: "X" }).ok, false);
    assert.strictEqual(ADR.verifica({ tara: "România", judet: "jud. Ilfov", localitate: "Voluntari" }).ok, true);
    assert.strictEqual(ADR.verifica({ tara: "Grecia", judet: "", localitate: "Atalanti" }).ok, true, "în afara României județul nu se cere");
    assert.strictEqual(ADR.verifica({ tara: "Romania", judet: "Ilfov", localitate: "" }).ok, false);
  });

  // ---- ruta, până la ușa SmartBill -------------------------------------------

  process.env.SMARTBILL_EMAIL = "test@exemplu.ro";
  process.env.SMARTBILL_TOKEN = "x";
  process.env.SMARTBILL_CIF = "RO27244210";
  const plecate = [];
  global.fetch = async (url, opt) => {
    plecate.push({ url, corp: JSON.parse(opt.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ series: "CSHM", number: "3400" }) };
  };

  const PARTENERI = {
    28: { id: 28, nume: "DING COMMUNICATION SRL", cui: "RO27078460", email: null, tara: null, judet: null, localitate: null,
      adresa: "Str. Sat Dobridor Com. Motatei, Str. Grefierului, Nr.2, Loc.Dobridor, Jud. Dolj, Tara Romania" },
    35: { id: 35, nume: "FARA ADRESA SRL", cui: "RO35674765", email: null, tara: null, judet: null, localitate: null, adresa: null },
  };
  const FACTURI = {
    8386: { id: 8386, partener_id: 28, directie: "vanzare", serie: "FCT", numar: 1, data_emiterii: "2026-10-29", moneda: "RON", activ: 1 },
    8390: { id: 8390, partener_id: 35, directie: "vanzare", serie: "FCT", numar: 2, data_emiterii: "2026-10-29", moneda: "EUR", activ: 1 },
  };
  const LINII = {
    8386: [{ id: 1, factura_id: 8386, produs_id: 9, denumire: "Banda adeziva acrylic transparent 120*48", cantitate: 360, pret_unitar: 4.99, cota_tva: 21, unitate_masura: "rola" }],
    8390: [{ id: 2, factura_id: 8390, produs_id: null, denumire: "Folie", cantitate: 10, pret_unitar: 2, cota_tva: 21, unitate_masura: null }],
  };
  const scrise = [];
  const fals = (sql) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    return {
      async get(...a) {
        if (/FROM \(SELECT \* FROM facturi WHERE activ = 1\) f JOIN parteneri p/.test(s)) {
          const f = FACTURI[Number(a[0])];
          if (!f) return undefined;
          const p = PARTENERI[f.partener_id];
          return { ...f, partener_nume: p.nume, cui: p.cui, adresa: p.adresa, email: p.email, tara: p.tara, judet: p.judet, localitate: p.localitate };
        }
        return undefined;
      },
      async all(...a) {
        if (/FROM facturi_linii fl/.test(s)) return LINII[Number(a[0])] || [];
        return [];
      },
      async run(...a) {
        scrise.push({ sql: s, args: a });
        let m;
        if ((m = /^UPDATE parteneri SET (tara|judet|localitate) = \? WHERE id = \? AND COALESCE/.exec(s))) {
          const p = PARTENERI[Number(a[1])];
          if (p && !p[m[1]]) p[m[1]] = a[0];
        }
        if (/^UPDATE parteneri SET tara = \?, judet = \?, localitate = \? WHERE id = \?/.test(s)) {
          Object.assign(PARTENERI[Number(a[3])], { tara: a[0], judet: a[1], localitate: a[2] });
        }
        return {};
      },
    };
  };
  const abs = require.resolve("./lib/db");
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = { prepare: fals, exec: async () => {} };
  require.cache[abs] = m;

  const facturi = require("./modules/facturi");
  const rute = { get: new Map(), post: new Map() };
  facturi.register({ get: (c, f) => rute.get.set(c, f), post: (c, f) => rute.post.set(c, f) });
  const cere = async (cale, id, body) => {
    const r = { cod: 0, antete: {}, corp: "", writeHead(c, h) { this.cod = c; Object.assign(this.antete, h || {}); }, end(t) { this.corp = String(t || ""); } };
    await rute.post.get(cale)({ res: r, params: { id: String(id) }, query: {}, body: body || {}, user: { id: 1, rol: "admin", nume: "Vali" }, req: { headers: {} } });
    return r;
  };

  await test("FCT-1 către Ding pleacă direct, cu țara, județul și localitatea", async () => {
    plecate.length = 0;
    const r = await cere("/facturi/:id/smartbill", 8386);
    assert.strictEqual(r.cod, 302, "trebuia trimisă și întoarsă la factură, nu oprită");
    assert.strictEqual(plecate.length, 1, "trebuia să plece exact o cerere");
    const c = plecate[0].corp.client;
    assert.strictEqual(c.country, "Romania", "fără țară SmartBill refuză factura — exact eroarea din poză");
    assert.strictEqual(c.county, "Dolj");
    assert.strictEqual(c.city, "Dobridor");
  });

  await test("ce s-a citit din adresă a ajuns și în fișa clientului", async () => {
    assert.deepStrictEqual([PARTENERI[28].tara, PARTENERI[28].judet, PARTENERI[28].localitate], ["Romania", "Dolj", "Dobridor"]);
  });

  await test("unitatea de măsură vine din produs, iar moneda pleacă", async () => {
    const corp = plecate[0].corp;
    assert.strictEqual(corp.products[0].measuringUnitName, "rola", "nu „buc” pe orice linie");
    assert.strictEqual(corp.currency, "RON");
    assert.strictEqual(corp.products[0].currency, "RON");
  });

  await test("client fără adresă: apare formularul, NU pleacă nimic la SmartBill", async () => {
    plecate.length = 0;
    const r = await cere("/facturi/:id/smartbill", 8390);
    assert.strictEqual(r.cod, 200);
    assert.strictEqual(plecate.length, 0, "a plecat o factură cu clientul incomplet");
    assert.ok(r.corp.includes('action="/facturi/8390/smartbill/client"'), "lipsește formularul");
    assert.ok(/lipsesc: <strong>județul, localitatea/.test(r.corp), "trebuie să spună ce lipsește");
  });

  await test("formularul cu județ lipsă pentru România: eroare, nimic trimis, nimic scris", async () => {
    plecate.length = 0;
    const r = await cere("/facturi/:id/smartbill/client", 8390, { tara: "Romania", judet: "", localitate: "Voluntari" });
    assert.strictEqual(plecate.length, 0);
    assert.ok(/Alege județul/.test(r.corp));
    assert.strictEqual(PARTENERI[35].judet, null);
  });

  await test("formularul completat: datele rămân în fișă și factura pleacă, în euro", async () => {
    plecate.length = 0;
    const r = await cere("/facturi/:id/smartbill/client", 8390, { tara: "România", judet: "Ilfov", localitate: "Voluntari" });
    assert.strictEqual(r.cod, 302);
    assert.deepStrictEqual([PARTENERI[35].tara, PARTENERI[35].judet, PARTENERI[35].localitate], ["Romania", "Ilfov", "Voluntari"]);
    const corp = plecate[0].corp;
    assert.deepStrictEqual([corp.client.country, corp.client.county, corp.client.city], ["Romania", "Ilfov", "Voluntari"]);
    assert.strictEqual(corp.currency, "EUR", "o factură în euro nu pleacă drept factură în lei");
    assert.strictEqual(corp.products[0].measuringUnitName, "buc", "fără produs, rămâne „buc”");
  });

  await test("a doua oară, același client pleacă direct, din fișă", async () => {
    plecate.length = 0;
    const r = await cere("/facturi/:id/smartbill", 8390);
    assert.strictEqual(r.cod, 302);
    assert.strictEqual(plecate.length, 1);
  });

  await test("o eroare de la SmartBill spune cu ce date a plecat clientul", async () => {
    global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ errorText: "judetul nu este valid" }) });
    const r = await cere("/facturi/:id/smartbill", 8386);
    assert.ok(/judetul nu este valid/.test(r.corp));
    assert.ok(/Dobridor, Dolj, Romania/.test(r.corp), "omul trebuie să vadă ce a plecat, ca să știe ce să corecteze");
  });

  console.log(`\n${treceri} verificări trecute.`);
})().catch((e) => {
  console.error("\nCĂZUT:", e.message);
  process.exit(1);
});
