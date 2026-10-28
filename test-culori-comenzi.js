"use strict";
// Culoarea unei comenzi, aceeași în orice pagină.
//
// CEREREA LUI VALI, 28.10.2026: „comanda nouă roșu, în producție albastru,
// finalizată verde, livrată sau în livrare negru" — și imediat după:
// „culorile să urmărească comenzile în orice pagină."
//
// A doua propoziție e cea care a cerut testul ăsta. Culorile erau scrise în
// TREI locuri care nu știau unul de altul:
//   1. lib/comenzi-stari.js      — comenzile de vânzare
//   2. modules/productie.js      — registrul de producție
//   3. public/style.css (.sel-stare) — selectul de stare din registru,
//      al cărui comentariu promitea „aceeași culoare cu a insignei", și nu
//      mai era de mult.
// Aceeași comandă își schimba culoarea când treceai dintr-o pagină în alta.
//
// Testul nu verifică doar că scrie roșu unde trebuie. Verifică mai ales că
// cele trei locuri spun ACELAȘI lucru — fiindcă asta s-a stricat, și asta se
// strică din nou la prima culoare schimbată în grabă într-un singur fișier.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

let treceri = 0;
function test(nume, f) {
  f();
  treceri++;
  console.log("  ok —", nume);
}

// lib/comenzi-stari.js trage după el lib/render.js → lib/auth.js → lib/db.js,
// iar `pg` nu se poate instala aici. Baza nu e folosită de nimic din ce
// verificăm, deci îi punem o coajă.
const abs = require.resolve("./lib/db.js");
const fals = new Module(abs, null);
fals.filename = abs;
fals.loaded = true;
fals.exports = { prepare: () => ({ all: async () => [], get: async () => null, run: async () => ({}) }), exec: async () => {} };
require.cache[abs] = fals;

const STARI = require("./lib/comenzi-stari");
const PROD = require("./modules/productie");
const CSS = fs.readFileSync(path.join(__dirname, "public", "style.css"), "utf8");

// ---- ce a cerut Vali, cuvânt cu cuvânt -----------------------------------

test("comanda nouă e roșie", () => {
  assert.strictEqual(STARI.culoare("noua"), "rosu");
});

test("comanda în producție e albastră", () => {
  assert.strictEqual(STARI.culoare("in_productie"), "albastru");
});

test("comanda finalizată e verde", () => {
  // „Finalizată" în registrul de producție și „în stoc depozit" la vânzări
  // sunt același lucru văzut din două birouri: marfa e gata.
  assert.strictEqual(STARI.culoare("finalizata"), "verde");
  assert.strictEqual(STARI.culoare("in_stoc_depozit"), "verde");
});

test("comanda livrată sau în livrare e neagră", () => {
  assert.strictEqual(STARI.culoare("livrata"), "negru");
  assert.strictEqual(STARI.culoare("livrata_partial"), "negru");
});

// ---- coerența schemei ----------------------------------------------------

test("roșu înseamnă un singur lucru: nouă, neatinsă", () => {
  // „Anulată" era tot roșie. Dacă roșu înseamnă și „cere ceva de la tine", și
  // „rând mort", te uiți peste listă și nu mai știi care e care.
  const rosii = Object.entries(STARI.CULORI).filter(([, c]) => c === "rosu").map(([s]) => s);
  assert.deepStrictEqual(rosii, ["noua"], "mai e o stare roșie în afară de „nouă”: " + rosii.join(", "));
  assert.strictEqual(STARI.culoare("anulata"), "gri", "anulată trebuie să fie gri, nu roșie");
});

test("o stare necunoscută nu împrumută înțelesul alteia", () => {
  assert.strictEqual(STARI.culoare("ceva_ce_nu_exista"), "gri");
  assert.strictEqual(STARI.culoare(""), "gri");
  assert.strictEqual(STARI.culoare(null), "gri");
  assert.strictEqual(STARI.culoare(undefined), "gri");
});

test("eticheta poartă culoarea din tabel, nu una scrisă de mână", () => {
  for (const [stare, culoare] of Object.entries(STARI.CULORI)) {
    const et = STARI.STATUS_LABEL[stare];
    if (!et) continue; // livrata_partial și finalizata n-au etichetă la vânzări
    assert.ok(
      et.includes('class="badge ' + culoare + '"'),
      `eticheta lui „${stare}” nu poartă culoarea ${culoare}: ${et}`
    );
  }
});

// ---- aceeași culoare în toate cele trei locuri ---------------------------

test("registrul de producție citește același tabel, nu o copie", () => {
  for (const [cheie, , culoare] of PROD.STATUSURI) {
    assert.strictEqual(
      culoare,
      STARI.culoare(cheie),
      `în registrul de producție „${cheie}” e ${culoare}, iar la vânzări ${STARI.culoare(cheie)}`
    );
  }
  const sursa = fs.readFileSync(path.join(__dirname, "modules", "productie.js"), "utf8");
  assert.ok(sursa.includes("STARI.culoare("), "registrul și-a făcut iar lista lui de culori");
});

test("selectul de stare din registru are aceleași culori ca insignele", () => {
  // Culorile insignei, ca să le putem compara cu ale selectului.
  const INSIGNA = {
    rosu: "#f8e5e3",
    verde: "#e7f4ec",
    galben: "#fbf0da",
    albastru: "#e6edf7",
    gri: "#eef0f3",
    negru: "#22262b",
  };
  for (const [culoare, hex] of Object.entries(INSIGNA)) {
    assert.ok(
      new RegExp("\\.badge\\." + culoare + "\\s*\\{[^}]*background:\\s*" + hex, "i").test(CSS),
      `.badge.${culoare} nu mai e ${hex} — actualizează și selectul de stare`
    );
  }
  // Fiecare stare din tabel trebuie să aibă o regulă .sel-stare cu fundalul
  // culorii ei. Altfel selectul din registru arată altceva decât insigna de
  // pe fișa aceleiași comenzi.
  for (const [stare, culoare] of Object.entries(STARI.CULORI)) {
    const re = new RegExp("\\.sel-stare\\.stare-" + stare + "\\b[^{]*\\{[^}]*background:\\s*" + INSIGNA[culoare], "i");
    const reGrupat = new RegExp("\\.sel-stare\\.stare-" + stare + "\\s*,[\\s\\S]{0,200}?background:\\s*" + INSIGNA[culoare], "i");
    assert.ok(re.test(CSS) || reGrupat.test(CSS), `starea „${stare}” n-are în CSS fundalul ${INSIGNA[culoare]} (${culoare})`);
  }
});

test("nicio stare nu se afișează ca nume de coloană din bază", () => {
  // „livrata_partial" ieșea ca text brut, fără insignă. Orice stare din
  // tabelul de culori trebuie să iasă desenată și scrisă pe românește.
  for (const stare of Object.keys(STARI.CULORI)) {
    const et = STARI.eticheta(stare);
    assert.ok(et.includes('class="badge '), `„${stare}” nu iese ca insignă: ${et}`);
    assert.ok(!et.includes("_"), `„${stare}” se afișează cu underscore, ca în bază: ${et}`);
    assert.ok(et.includes(STARI.culoare(stare)), `„${stare}” nu poartă culoarea ei`);
  }
  assert.strictEqual(STARI.eticheta("ceva_ce_nu_exista"), "ceva_ce_nu_exista", "ce nu e în tabel rămâne text simplu");
  assert.strictEqual(STARI.eticheta(""), "—");
});

test("stările de producție nu intră în selectul comenzilor de vânzare", () => {
  // Din TEXTE se naște lista pe care o poate alege adminul. „Finalizată" și
  // „livrată parțial" au culoare, dar nu sunt pe drumul unei comenzi de
  // vânzare — dacă ar intra în STATUS_LABEL, ar apărea în acel select.
  const alese = STARI.stariPermise({ rol: "admin", id: 1 }, { agent_id: 1 });
  assert.ok(!alese.includes("finalizata"), "„finalizată” n-are ce căuta în selectul de la vânzări");
  assert.ok(!alese.includes("livrata_partial"));
  assert.ok(alese.includes("noua") && alese.includes("livrata"), "selectul trebuie să rămână întreg");
});

test("insigna neagră există în CSS și are text alb", () => {
  // Fără ea, „livrată" ar primi o clasă fără nicio regulă și ar ieși o
  // insignă transparentă, fără să cadă nimic și fără să observe nimeni.
  assert.ok(/\.badge\.negru\s*\{[^}]*background:\s*#22262b/i.test(CSS));
  assert.ok(/\.badge\.negru\s*\{[^}]*color:\s*#ffffff/i.test(CSS), "pe fundal închis, textul trebuie să fie alb");
});

console.log(`\n${treceri} verificări trecute.`);
