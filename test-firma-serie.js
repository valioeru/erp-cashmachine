"use strict";
// Facturile puse pe altă firmă decât a seriei lor.
//
// Partea 1 verifică regula (lib/firma-serie.js), fără bază de date.
// Partea 2 rulează verificarea, butonul de mutare și anularea pe o bază de
// hârtie, ca să se vadă ce SQL pleacă și ce se schimbă.
//
// De unde a pornit: sincronizarea din SmartBill a pus o vreme facturi Cash
// Machine pe Warehouse All, fiindcă citea firma din tabelul de clienți. Prima
// sincronizare de după reparație a raportat „serie_la_alta_firma: 4".

const assert = require("assert");
const Module = require("module");
const FS = require("./lib/firma-serie");

let treceri = 0;
async function test(nume, f) {
  await f();
  treceri++;
  console.log("  ok —", nume);
}

const CM = 1; // Cash Machine
const WHA = 2; // Warehouse All

(async () => {
  // ---- partea 1: regula ----------------------------------------------------

  await test("stăpânul unei serii e firma care ține aproape toate facturile ei", async () => {
    const h = FS.proprietari([
      { serie: "CSHM", firma_id: CM, n: 3128 },
      { serie: "CSHM", firma_id: WHA, n: 4 },
      { serie: "WHA", firma_id: WHA, n: 1080 },
    ]);
    assert.strictEqual(h.get("CSHM").firma_id, CM);
    assert.strictEqual(h.get("CSHM").nedecis, false);
    assert.strictEqual(h.get("WHA").firma_id, WHA);
  });

  await test("facturile rătăcite sunt cele de pe firma minoritară", async () => {
    const h = FS.proprietari([
      { serie: "CSHM", firma_id: CM, n: 3128 },
      { serie: "CSHM", firma_id: WHA, n: 4 },
    ]);
    const s = FS.suspecte(
      [
        { id: 10, serie: "CSHM", firma_id: CM },
        { id: 11, serie: "CSHM", firma_id: WHA },
        { id: 12, serie: "cshm ", firma_id: WHA }, // aceeași serie, scrisă altfel
      ],
      h
    );
    assert.deepStrictEqual(s.map((x) => x.id), [11, 12]);
    assert.strictEqual(s[0].firma_acum, WHA);
    assert.strictEqual(s[0].firma_corecta, CM);
  });

  await test("o serie împărțită aproape egal NU se atinge", async () => {
    // 60/40 nu e o greșeală de import — e o întrebare pentru om. Un buton
    // care mută facturi pe o majoritate firavă ar strica mai mult.
    const h = FS.proprietari([
      { serie: "XYZ", firma_id: CM, n: 60 },
      { serie: "XYZ", firma_id: WHA, n: 40 },
    ]);
    assert.strictEqual(h.get("XYZ").nedecis, true);
    assert.match(h.get("XYZ").motiv, /împărțită/);
    assert.deepStrictEqual(FS.suspecte([{ id: 1, serie: "XYZ", firma_id: WHA }], h), []);
  });

  await test("o serie cu prea puține facturi nu are încă stăpân", async () => {
    const h = FS.proprietari([
      { serie: "NOU", firma_id: CM, n: 3 },
      { serie: "NOU", firma_id: WHA, n: 1 },
    ]);
    assert.strictEqual(h.get("NOU").nedecis, true);
    assert.match(h.get("NOU").motiv, /prea puține/);
  });

  await test("exact pe prag (90%) seria are stăpân", async () => {
    const h = FS.proprietari([
      { serie: "P", firma_id: CM, n: 90 },
      { serie: "P", firma_id: WHA, n: 10 },
    ]);
    assert.strictEqual(h.get("P").nedecis, false);
  });

  await test("facturile fără firmă se pun pe stăpânul seriei, dar nu pot fi ele stăpânul", async () => {
    const h = FS.proprietari([
      { serie: "CSHM", firma_id: CM, n: 50 },
      { serie: "CSHM", firma_id: null, n: 2 },
    ]);
    assert.strictEqual(h.get("CSHM").firma_id, CM);
    const s = FS.suspecte([{ id: 5, serie: "CSHM", firma_id: null }], h);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].firma_acum, null);
    // Doar facturi fără firmă: nimeni nu e stăpân, nimic nu se mută.
    const h2 = FS.proprietari([{ serie: "Z", firma_id: null, n: 40 }]);
    assert.strictEqual(h2.get("Z").nedecis, true);
  });

  await test("anularea pune la loc doar ce e încă unde l-a pus mutarea", async () => {
    const plan = FS.planulMutarii([
      { id: 11, firma_acum: WHA, firma_corecta: CM },
      { id: 12, firma_acum: WHA, firma_corecta: CM },
      { id: 13, firma_acum: null, firma_corecta: CM },
    ]);
    // Între timp cineva a mutat 12 pe altă firmă (3) — decizie mai nouă, rămâne.
    const acum = new Map([[11, CM], [12, 3], [13, CM]]);
    assert.deepStrictEqual(FS.deAnulat(plan, acum).map((p) => p.id), [11, 13]);
    // Și dacă factura nu mai există deloc, nu se încearcă nimic pe ea.
    assert.deepStrictEqual(FS.deAnulat(plan, new Map([[11, CM]])).map((p) => p.id), [11]);
  });

  // ---- partea 2: verificarea, mutarea și anularea, pe o bază de hârtie -----

  // Starea „bazei": facturile, cu firma lor. Numărătorile se calculează din
  // ele, ca să nu poată ieși din sincron cu ce verificăm.
  let facturi;
  let mutari;
  const scrise = [];
  function reseteaza() {
    facturi = [];
    for (let i = 0; i < 40; i++) facturi.push({ id: 100 + i, serie: "CSHM", numar: 3000 + i, firma_id: CM, total: 1000 });
    for (let i = 0; i < 20; i++) facturi.push({ id: 200 + i, serie: "WHA", numar: 1000 + i, firma_id: WHA, total: 500 });
    // Cele rătăcite: două CSHM pe Warehouse All.
    facturi.push({ id: 900, serie: "CSHM", numar: 3322, firma_id: WHA, total: 1936 });
    facturi.push({ id: 901, serie: "CSHM", numar: 3323, firma_id: WHA, total: 66671 });
    mutari = [];
    scrise.length = 0;
  }

  const bazaFalsa = {
    prepare(sql) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      return {
        async all(...a) {
          if (/GROUP BY UPPER\(TRIM/.test(s)) {
            const m = new Map();
            for (const f of facturi) {
              const k = `${f.serie}|${f.firma_id}`;
              m.set(k, (m.get(k) || 0) + 1);
            }
            return [...m.entries()].map(([k, n]) => {
              const [serie, firma] = k.split("|");
              return { serie, firma_id: firma === "null" ? null : Number(firma), n };
            });
          }
          if (/FROM \(SELECT \* FROM facturi WHERE activ = 1\) f LEFT JOIN parteneri/.test(s)) {
            return facturi.filter((f) => a.includes(f.serie)).map((f) => ({ ...f, partener: "Client " + f.id }));
          }
          if (/SELECT id, nume FROM firme/.test(s)) return [{ id: CM, nume: "Cash Machine SRL" }, { id: WHA, nume: "Warehouse All SRL" }];
          if (/SELECT id, firma_id FROM facturi WHERE id IN/.test(s)) return facturi.filter((f) => a.includes(f.id)).map((f) => ({ id: f.id, firma_id: f.firma_id }));
          if (/FROM mutari_firma/.test(s)) return mutari.slice().reverse();
          return [];
        },
        async get(...a) {
          if (/SELECT \* FROM mutari_firma WHERE id = \?/.test(s)) return mutari.find((m) => m.id === Number(a[0])) || null;
          return null;
        },
        async run(...a) {
          scrise.push({ sql: s, args: a });
          let m;
          if ((m = /^UPDATE facturi SET firma_id = \? WHERE id = \? AND firma_id (= \?|IS NULL)$/.exec(s))) {
            const f = facturi.find((x) => x.id === Number(a[1]));
            const conditie = m[1] === "IS NULL" ? f && f.firma_id === null : f && f.firma_id === a[2];
            if (conditie) f.firma_id = a[0] === null ? null : Number(a[0]);
          }
          if (/^INSERT INTO mutari_firma/.test(s)) mutari.push({ id: mutari.length + 1, facut_de: a[0], nr_facturi: a[1], suma: a[2], detalii: a[3], anulata_la: null });
          if (/^UPDATE mutari_firma SET anulata_la/.test(s)) {
            const x = mutari.find((y) => y.id === Number(a[2]));
            if (x) x.anulata_la = a[0];
          }
          return {};
        },
      };
    },
    async exec() {},
  };

  const abs = require.resolve("./lib/db.js");
  const mod = new Module(abs, null);
  mod.filename = abs;
  mod.loaded = true;
  mod.exports = bazaFalsa;
  require.cache[abs] = mod;

  const verificari = require("./modules/verificari");
  const rute = { get: new Map(), post: new Map() };
  verificari.register({ get: (c, f) => rute.get.set(c, f), post: (c, f) => rute.post.set(c, f) });

  const cheama = async (metoda, cale, { params, user, query } = {}) => {
    const res = { cod: 0, antete: {}, writeHead(c, h) { this.cod = c; Object.assign(this.antete, h || {}); }, end(b) { this.corp = b; } };
    await rute[metoda].get(cale)({ res, params: params || {}, query: query || {}, body: {}, user: user || { id: 1, rol: "admin" }, req: { headers: {} } });
    return res;
  };

  await test("rutele există", async () => {
    assert.ok(rute.post.has("/admin/date/serie-alta-firma/muta"));
    assert.ok(rute.post.has("/admin/date/mutari-firma/:id/anuleaza"));
  });

  await test("mutarea pune pe firma seriei EXACT facturile rătăcite, și nimic altceva", async () => {
    reseteaza();
    const res = await cheama("post", "/admin/date/serie-alta-firma/muta");
    assert.strictEqual(res.cod, 302);
    assert.match(res.antete.Location, /mutate=2#mutari-firma/);
    assert.strictEqual(facturi.find((f) => f.id === 900).firma_id, CM);
    assert.strictEqual(facturi.find((f) => f.id === 901).firma_id, CM);
    // Facturile WHA, care sunt pe firma lor, n-au fost atinse.
    assert.ok(facturi.filter((f) => f.serie === "WHA").every((f) => f.firma_id === WHA));
    const update = scrise.filter((x) => /^UPDATE facturi/.test(x.sql));
    assert.strictEqual(update.length, 2, "s-au scris mai multe facturi decât cele rătăcite");
    // Nicio altă coloană nu se schimbă: nici suma, nici clientul, nici data.
    assert.ok(update.every((x) => /^UPDATE facturi SET firma_id = \? WHERE/.test(x.sql)));
  });

  await test("mutarea lasă în istoric de unde a plecat fiecare factură", async () => {
    assert.strictEqual(mutari.length, 1);
    const plan = JSON.parse(mutari[0].detalii);
    assert.deepStrictEqual(plan, [
      { id: 900, de_la: WHA, la: CM },
      { id: 901, de_la: WHA, la: CM },
    ]);
    assert.strictEqual(mutari[0].suma, 1936 + 66671);
  });

  await test("după mutare, a doua apăsare nu mai găsește nimic de mutat", async () => {
    scrise.length = 0;
    await cheama("post", "/admin/date/serie-alta-firma/muta");
    assert.strictEqual(scrise.filter((x) => /^UPDATE facturi/.test(x.sql)).length, 0);
    assert.strictEqual(mutari.length, 1, "nu trebuie să apară o mutare goală în istoric");
  });

  await test("anularea le pune înapoi pe firma de unde au plecat", async () => {
    await cheama("post", "/admin/date/mutari-firma/:id/anuleaza", { params: { id: "1" } });
    assert.strictEqual(facturi.find((f) => f.id === 900).firma_id, WHA);
    assert.strictEqual(facturi.find((f) => f.id === 901).firma_id, WHA);
    assert.ok(mutari[0].anulata_la, "mutarea trebuie marcată ca anulată");
  });

  await test("anularea nu calcă o mutare făcută între timp de altcineva", async () => {
    reseteaza();
    await cheama("post", "/admin/date/serie-alta-firma/muta");
    // Cineva mută de mână factura 901 pe o a treia firmă.
    facturi.find((f) => f.id === 901).firma_id = 3;
    await cheama("post", "/admin/date/mutari-firma/:id/anuleaza", { params: { id: "1" } });
    assert.strictEqual(facturi.find((f) => f.id === 900).firma_id, WHA, "900 trebuia pusă la loc");
    assert.strictEqual(facturi.find((f) => f.id === 901).firma_id, 3, "901 a fost mutată între timp de un om — rămâne cum a hotărât el");
  });

  await test("o mutare anulată nu se mai poate anula a doua oară", async () => {
    scrise.length = 0;
    await cheama("post", "/admin/date/mutari-firma/:id/anuleaza", { params: { id: "1" } });
    assert.strictEqual(scrise.filter((x) => /^UPDATE facturi/.test(x.sql)).length, 0);
  });

  await test("doar adminul mută și anulează", async () => {
    reseteaza();
    await cheama("post", "/admin/date/serie-alta-firma/muta", { user: { id: 5, rol: "financiar" } });
    assert.strictEqual(facturi.find((f) => f.id === 900).firma_id, WHA, "financiarul n-are voie să mute facturi între firme");
    assert.strictEqual(mutari.length, 0);
  });

  console.log(`\n${treceri} verificări trecute.`);
})().catch((e) => {
  console.error("\nCĂZUT:", e.message);
  process.exit(1);
});
