"use strict";
// Prețul unitar din formularul de comandă.
//
// CE A RAPORTAT VALI, 29.10.2026, cu o poză: o linie de 150.000 pungi avea
// prețul 0.16005859375, câmpul ieșea din tabel, și „vrea doar acea valoare".
//
// Reprodus în Chromium, tastând: câmpul era <input type="number"
// step="0.0001" value="0.16005859375">. În HTML pasul se numără de la
// valoarea cu care pornește câmpul, așa că 0,16 era respins cu „cele mai
// apropiate valori valide sunt 0.15995859375 și 0.16005859375". Singurul
// preț rotund care trecea era... niciunul.
//
// Și a doua capcană din același câmp: într-un browser pe engleză, „0,16"
// devenea „016", adică 16 lei — de o sută de ori prețul.
//
// Testul are trei părți: regula (lib/pret-camp.js), ce desenează formularul,
// și ce scriu cele două rute de salvare în bază.

const assert = require("assert");
const Module = require("module");
const PC = require("./lib/pret-camp");

let treceri = 0;
async function test(nume, f) {
  await f();
  treceri++;
  console.log("  ok —", nume);
}

(async () => {
  // ---- regula --------------------------------------------------------------

  await test("prețul se arată cu cel mult 4 zecimale, cu virgulă", async () => {
    assert.strictEqual(PC.pretPentruCamp(0.16005859375), "0,1601");
    assert.strictEqual(PC.pretPentruCamp(0.0657), "0,0657");
    assert.strictEqual(PC.pretPentruCamp(0.16), "0,16");
    assert.strictEqual(PC.pretPentruCamp(23.5), "23,5");
    assert.strictEqual(PC.pretPentruCamp(12), "12");
    assert.strictEqual(PC.pretPentruCamp(1000), "1000", "zerourile din partea întreagă nu se taie");
    assert.strictEqual(PC.pretPentruCamp(0), "", "ca înainte: prețul zero lasă câmpul gol");
    assert.strictEqual(PC.pretPentruCamp(null), "");
  });

  await test("ce a tastat omul se citește cu virgulă SAU punct", async () => {
    assert.deepStrictEqual(PC.pretDinCamp("0,16"), { ok: true, valoare: 0.16 }, "„0,16” e 0,16 lei — nu 16");
    assert.deepStrictEqual(PC.pretDinCamp("0.16"), { ok: true, valoare: 0.16 });
    assert.deepStrictEqual(PC.pretDinCamp("0, 16"), { ok: true, valoare: 0.16 });
    assert.deepStrictEqual(PC.pretDinCamp(",5"), { ok: true, valoare: 0.5 });
    assert.deepStrictEqual(PC.pretDinCamp("16,"), { ok: true, valoare: 16 });
    assert.deepStrictEqual(PC.pretDinCamp(""), { ok: true, valoare: 0 });
  });

  await test("ce e ambiguu se refuză, nu se ghicește", async () => {
    // „1.234,56" poate fi 1,23 sau 1.234,56 — de o mie de ori diferență.
    for (const s of ["1.234,56", "1,234.56", "abc", "-1", "1..2"]) {
      assert.strictEqual(PC.pretDinCamp(s).ok, false, `„${s}” trebuia refuzat`);
    }
  });

  await test("ce tastează omul se rotunjește la 4 zecimale", async () => {
    assert.strictEqual(PC.pretDinCamp("0,16005859375").valoare, 0.1601);
  });

  await test("prețul neatins rămâne EXACT cel din bază", async () => {
    // Câmpul arată 0,1601, dar nu are voie să mute singur prețul de pe
    // 150.000 de bucăți: ar fi 6,21 lei pe care nu i-a cerut nimeni.
    assert.deepStrictEqual(PC.pretDeScris("0,1601", "0.16005859375"), { ok: true, valoare: 0.16005859375 });
    // Atins (pagina a golit câmpul ascuns): se scrie ce a tastat omul.
    assert.deepStrictEqual(PC.pretDeScris("0,16", ""), { ok: true, valoare: 0.16 });
    // Formular vechi, fără câmpul ascuns: se citește ce a venit.
    assert.deepStrictEqual(PC.pretDeScris("0.42", undefined), { ok: true, valoare: 0.42 });
  });

  await test("nota „în bază” apare doar când prețul chiar are mai multe zecimale", async () => {
    assert.strictEqual(PC.areZecimaleInPlus(0.16005859375), true);
    assert.strictEqual(PC.areZecimaleInPlus(0.0657), false);
    assert.strictEqual(PC.areZecimaleInPlus(0.16), false);
    assert.strictEqual(PC.areZecimaleInPlus(""), false);
    assert.strictEqual(PC.scrieExact(0.16005859375), "0,16005859375");
  });

  await test("funcția de afișare se poate pune ca text în pagină", async () => {
    // Pagina o primește prin .toString(), într-un șablon de text. Un backtick
    // sau un „${" în ea ar rupe șablonul și întreaga pagină de comandă.
    const src = PC.pretPentruCamp.toString();
    assert.ok(!/`|\$\{/.test(src), "pretPentruCamp conține backtick sau ${");
    // Și dă același rezultat ca pe server.
    const dinPagina = new Function("return " + src)();
    for (const v of [0.16005859375, 0.0657, 12, 0, "0,16"]) assert.strictEqual(dinPagina(v), PC.pretPentruCamp(v));
  });

  // ---- formularul și rutele, pe o bază de hârtie ----------------------------

  const BAZA = {
    comenzi: [{ id: 30, partener_id: 2, numar: "CMD-30", status: "noua", agent_id: 5, moneda: "RON",
      livrare_partiala: "nu", data_livrare_ceruta: "2026-10-26", observatii: "", curs_bnr: null, curs_bnr_data: null }],
    parteneri: [{ id: 2, nume: "DELIVERY SOLUTIONS SA", cui: "RO2", agent_id: 5, tip: "client" }],
    linii: [
      { id: 90, comanda_id: 30, produs_id: 2, cantitate: 150000, pret_unitar: 0.16005859375, um: "buc", cantitate_livrata: 0 },
      { id: 91, comanda_id: 30, produs_id: 4, cantitate: 700000, pret_unitar: 0.0657, um: "buc", cantitate_livrata: 0 },
    ],
    produse: [
      { id: 2, cod: "PC1", denumire: "Punga curier LDPE COEX", pret_vanzare: 0.16005859375, categorie: "Pungi curier", unitate_masura: "buc", activ: 1 },
      { id: 4, cod: "PL1", denumire: "Plicuri autoadezive AWB C5", pret_vanzare: 0.0657, categorie: "Plicuri AWB", unitate_masura: "buc", activ: 1 },
    ],
    istoric: [],
    inserate: [],
  };
  let urm = 500;
  const fals = (sql) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    return {
      async get(...a) {
        if (/FROM comenzi c JOIN parteneri/i.test(s)) {
          const c = BAZA.comenzi.find((x) => x.id === Number(a[0]));
          return c ? { ...c, partener_nume: "DELIVERY SOLUTIONS SA" } : undefined;
        }
        if (/FROM parteneri WHERE id/i.test(s)) return BAZA.parteneri.find((x) => x.id === Number(a[0]));
        if (/FROM produse WHERE id/i.test(s)) return BAZA.produse.find((x) => x.id === Number(a[0]));
        if (/COUNT\(\*\)/i.test(s)) return { n: 0 };
        return undefined;
      },
      async all(...a) {
        if (/FROM comenzi_linii cl JOIN produse/i.test(s)) {
          return BAZA.linii.filter((l) => l.comanda_id === Number(a[0])).map((l) => ({ ...l, denumire: (BAZA.produse.find((p) => p.id === l.produs_id) || {}).denumire }));
        }
        if (/FROM comenzi_linii/i.test(s)) return BAZA.linii.filter((l) => l.comanda_id === Number(a[0]));
        if (/FROM parteneri/i.test(s)) return BAZA.parteneri;
        if (/FROM utilizatori/i.test(s)) return [{ id: 5, nume: "Agent" }];
        if (/FROM produse/i.test(s)) return BAZA.produse;
        return [];
      },
      async run(...a) {
        if (/INSERT INTO comenzi_istoric/i.test(s)) { BAZA.istoric.push({ ce: a[3], vechi: a[4], nou: a[5] }); return { lastInsertRowid: ++urm }; }
        if (/UPDATE comenzi_linii SET/i.test(s)) {
          const l = BAZA.linii.find((x) => x.id === Number(a[3]));
          if (l) Object.assign(l, { cantitate: a[0], pret_unitar: a[1], um: a[2] });
          return {};
        }
        if (/INSERT INTO comenzi_linii/i.test(s)) { BAZA.inserate.push({ comanda_id: a[0], produs_id: a[1], cantitate: a[2], pret_unitar: a[3] }); return { lastInsertRowid: ++urm }; }
        if (/INSERT INTO comenzi /i.test(s)) return { lastInsertRowid: 77 };
        return { lastInsertRowid: 0 };
      },
    };
  };
  const abs = require.resolve("./lib/db");
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = { prepare: fals, exec: async () => {}, migrate: async () => {} };
  require.cache[abs] = m;

  const comenzi = require("./modules/comenzi");
  const rute = [];
  comenzi.register({ get: (c, h) => rute.push(["GET", c, h]), post: (c, h) => rute.push(["POST", c, h]), use: () => {}, options: () => {} });
  const ruta = (met, cale) => rute.find((x) => x[0] === met && x[1] === cale)[2];
  const cere = async (met, cale, { body, params } = {}) => {
    const r = { cod: 0, antete: {}, corp: "", writeHead(c, h) { this.cod = c; Object.assign(this.antete, h || {}); }, end(t) { this.corp = String(t || ""); }, setHeader() {} };
    await ruta(met, cale)({ req: { headers: {} }, res: r, params: params || {}, query: {}, body: body || {}, user: { id: 5, nume: "Agent", rol: "vanzari" } });
    return r;
  };
  const formularDe = (linii) => ({
    partener_id: "2", numar: "CMD-30", data_livrare_ceruta: "2026-10-26", livrare_partiala: "nu", moneda: "RON", observatii: "",
    "produs_id[]": linii.map((l) => String(l.produs_id)),
    "cantitate[]": linii.map((l) => String(l.cantitate)),
    "pret_unitar[]": linii.map((l) => l.pret),
    "pret_exact[]": linii.map((l) => (l.exact === undefined ? "" : l.exact)),
    "um[]": linii.map(() => "buc"),
  });

  await test("formularul de modificare nu mai are capcana pasului", async () => {
    const r = await cere("GET", "/comenzi/:id/editare", { params: { id: "30" } });
    const h = r.corp;
    const camp = (h.match(/<input[^>]*name="pret_unitar\[\]"[^>]*>/) || [""])[0];
    assert.ok(camp, "lipsește câmpul de preț");
    assert.ok(!/step=/.test(camp), "câmpul de preț are iar step — capcana se întoarce");
    assert.ok(/type="text"/.test(camp) && /inputmode="decimal"/.test(camp), "text, cu tastatura de cifre pe telefon");
    assert.ok(/value="0,1601"/.test(camp), "prețul se arată rotunjit la 4 zecimale");
    assert.ok(h.includes('name="pret_exact[]" value="0.16005859375"'), "prețul exact trebuie să plece cu formularul");
    assert.ok(h.includes("în bază: 0,16005859375"), "nota cu prețul exact trebuie să se vadă");
    // Linia cu 4 zecimale nu primește notă. (Se numără nota, nu textul:
    // „în bază:" apare și în comentariile scriptului din pagină.)
    assert.strictEqual((h.match(/class="pret-exact"/g) || []).length, 1);
    // Cantitatea: step="any", nu „0.01" — aceeași capcană la kilogramele cu
    // multe zecimale.
    assert.ok(/name="cantitate\[\]"/.test(h) && !/step="0\.01"[^>]*name="cantitate/.test(h));
  });

  await test("formularul e destul de lat pentru tabel", async () => {
    const r = await cere("GET", "/comenzi/:id/editare", { params: { id: "30" } });
    assert.ok(/class="form form-comanda" style="max-width:980px"/.test(r.corp), "la 820 px tabelul ieșea cu 109 px din casetă");
    assert.ok(/@media \(max-width: 980px\)/.test(r.corp), "sub lățimea tabelului, rândurile trebuie să devină cartele");
  });

  await test("salvare fără să atingi prețul: prețul exact rămâne, istoricul nu scrie nimic despre el", async () => {
    BAZA.istoric.length = 0;
    const r = await cere("POST", "/comenzi/:id/editare", {
      params: { id: "30" },
      body: { ...formularDe([
        { produs_id: 2, cantitate: 150000, pret: "0,1601", exact: "0.16005859375" },
        { produs_id: 4, cantitate: 700000, pret: "0,0657", exact: "0.0657" },
      ]) },
    });
    assert.strictEqual(r.cod, 302, "trebuia să salveze și să trimită înapoi la comandă");
    assert.match(r.antete.Location, /ok=nimic/, "n-a schimbat nimic, deci nimic de scris");
    assert.strictEqual(BAZA.linii.find((l) => l.id === 90).pret_unitar, 0.16005859375, "prețul s-a schimbat singur");
    assert.strictEqual(BAZA.istoric.length, 0, "istoricul a scris o schimbare pe care n-a făcut-o nimeni");
  });

  await test("salvare cu 0,16 tastat: se scrie 0,16 și se vede în istoric", async () => {
    BAZA.istoric.length = 0;
    const r = await cere("POST", "/comenzi/:id/editare", {
      params: { id: "30" },
      body: { ...formularDe([
        { produs_id: 2, cantitate: 150000, pret: "0,16", exact: "" },
        { produs_id: 4, cantitate: 700000, pret: "0,0657", exact: "0.0657" },
      ]), motiv: "preț corectat" },
    });
    assert.strictEqual(r.cod, 302);
    assert.match(r.antete.Location, /ok=modificat/);
    assert.strictEqual(BAZA.linii.find((l) => l.id === 90).pret_unitar, 0.16);
    assert.strictEqual(BAZA.linii.find((l) => l.id === 91).pret_unitar, 0.0657, "linia neatinsă nu se schimbă");
    assert.ok(BAZA.istoric.length >= 1, "schimbarea de preț trebuia să intre în istoric");
  });

  await test("un preț de necitit oprește salvarea și spune pe ce linie", async () => {
    const inainte = BAZA.linii.find((l) => l.id === 90).pret_unitar;
    const r = await cere("POST", "/comenzi/:id/editare", {
      params: { id: "30" },
      body: formularDe([
        { produs_id: 2, cantitate: 150000, pret: "1.234,56", exact: "" },
        { produs_id: 4, cantitate: 700000, pret: "0,0657", exact: "0.0657" },
      ]),
    });
    assert.strictEqual(r.cod, 200, "trebuia să rămână pe formular, cu eroarea");
    assert.ok(/linia 1/.test(r.corp), "eroarea trebuie să spună linia");
    assert.strictEqual(BAZA.linii.find((l) => l.id === 90).pret_unitar, inainte, "nu trebuia scris nimic");
    // Ce a tastat omul se întoarce cu el, ca să-l îndrepte, nu să-l retasteze.
    assert.ok(r.corp.includes('value="1.234,56"'), "prețul tastat a dispărut din formular");
  });

  await test("comandă nouă: „0,16” se scrie 0,16 lei, nu 16", async () => {
    BAZA.inserate.length = 0;
    await cere("POST", "/comenzi", {
      body: { ...formularDe([{ produs_id: 2, cantitate: 1000, pret: "0,16" }]), numar: "N-1" },
    });
    const l = BAZA.inserate.find((x) => x.produs_id === 2);
    assert.ok(l, "linia n-a ajuns în bază");
    assert.strictEqual(l.pret_unitar, 0.16);
  });

  await test("comandă nouă cu preț de necitit: nu se scrie nimic", async () => {
    BAZA.inserate.length = 0;
    const r = await cere("POST", "/comenzi", {
      body: { ...formularDe([{ produs_id: 2, cantitate: 1000, pret: "abc" }]), numar: "N-2" },
    });
    assert.strictEqual(BAZA.inserate.length, 0);
    assert.ok(/nu e un număr/.test(r.corp));
  });

  console.log(`\n${treceri} verificări trecute.`);
})().catch((e) => {
  console.error("\nCĂZUT:", e.message);
  process.exit(1);
});
