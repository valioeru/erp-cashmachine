"use strict";
// Ce păzește testul ăsta: cele două locuri prin care, pe 20.10.2026, aceleași
// patru facturi au intrat de două ori în ERP — 81.757,76 lei de vânzări care
// nu existau.
//
// 1. În pagina SmartBill, `S.firma()` lua numele firmei cu o expresie
//    regulată peste TOT textul paginii. Printre clienții din raport stă și
//    „WAREHOUSE ALL SRL”, firmă din grup. Prima potrivire era clientul, nu
//    firma sesiunii, și lotul pleca etichetat greșit.
// 2. În ERP, cheia de dedublare e SERIE|NUMĂR|FIRMĂ. Cu altă firmă în cheie,
//    facturile nu se mai recunoșteau ca fiind deja în bază.
//
// Fiecare parte e reparată separat și fiecare e verificată separat: dacă una
// cedează din nou, cealaltă trebuie să țină singură.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { cheiaFacturii } = require("./lib/documente");

let treceri = 0;
function test(nume, f) {
  f();
  treceri++;
  console.log("  ok —", nume);
}

// ---- partea 1: citirea firmei din pagina SmartBill ------------------------
//
// Nu pornim un browser: luăm funcția din fișierul servit, îi dăm un document
// de mână (cel mai mic lucru care seamănă cu o pagină) și ne uităm ce alege.
// Un DOM de jucărie e de ajuns fiindcă funcția face exact două lucruri:
// querySelector și citit text.
function documentFals(parti) {
  const noduri = [];
  const fa = (sel, text) => noduri.push({ sel, innerText: text, textContent: text });
  if (parti.company) fa(".details-company", parti.company);
  if (parti.antet) fa("header", parti.antet);
  if (parti.tabel) fa("table", parti.tabel);
  return {
    querySelector(cautat) {
      // „header, .navbar, .topbar, #header" — oricare dintre ele.
      const cerute = String(cautat).split(",").map((x) => x.trim());
      return noduri.find((n) => cerute.includes(n.sel)) || null;
    },
  };
}

function iaFirmaDin() {
  // Fișierul e un IIFE care scrie pe `window`. Îi dăm un window și îl rulăm.
  const cod = fs.readFileSync(path.join(__dirname, "punte", "sincronizare.js"), "utf8");
  const fereastra = { location: { href: "https://cloud.smartbill.ro/raport/facturi/" } };
  const consola = { log() {} };
  // `document` e cerut doar la apel, nu la încărcare; îi dăm unul gol.
  const docGol = { querySelector: () => null, body: { innerText: "" } };
  new Function("window", "document", "console", "fetch", cod)(fereastra, docGol, consola, () => {});
  assert.ok(fereastra.__sync && typeof fereastra.__sync.firmaDin === "function", "sincronizare.js nu a expus firmaDin");
  return fereastra.__sync.firmaDin;
}

const firmaDin = iaFirmaDin();

test("ia firma din antetul SmartBill, nu din tabel", () => {
  const d = documentFals({
    company: "CASH MACHINE S.R.L.",
    tabel: "CSHM3323 WAREHOUSE ALL SRL 20/10/2026 55100.00",
  });
  assert.strictEqual(firmaDin(d), "CASH MACHINE S.R.L.");
});

test("un client care e firmă din grup NU mai trece drept firma noastră", () => {
  // Exact pagina care a produs dubla: niciun element de companie (antetul
  // încă nu se randase), iar în tabel primul nume potrivit e Warehouse All.
  const d = documentFals({ tabel: "CSHM3323 WAREHOUSE ALL SRL 20/10/2026 55100.00" });
  assert.strictEqual(
    firmaDin(d),
    "",
    "fără antet trebuie să întoarcă gol (ERP-ul pune firma implicită), nu numele clientului"
  );
});

test("plasa de siguranță citește antetul când lipsește elementul de companie", () => {
  const d = documentFals({
    antet: "SmartBill Documente emise WAREHOUSE ALL SRL Deconectare",
    tabel: "WHA1081 CASH MACHINE S.R.L. 21/10/2026 1200.00",
  });
  // Aici chiar pe Warehouse All e logată sesiunea, iar clientul e Cash
  // Machine — oglinda cazului de mai sus. Antetul decide.
  assert.strictEqual(firmaDin(d), "WAREHOUSE ALL SRL");
});

test("firmaDin nu crapă pe o pagină fără nimic recunoscut", () => {
  assert.strictEqual(firmaDin(documentFals({})), "");
  assert.strictEqual(firmaDin(documentFals({ antet: "SmartBill Deconectare" })), "");
});

// ---- partea 2: paza din ERP ----------------------------------------------
//
// Nu avem bază de date aici, deci verificăm regula, nu interogarea: cheia
// fără firmă trebuie să recunoască aceeași factură oricare ar fi firma din
// lot, și trebuie să DEOSEBEASCĂ serii diferite.

test("cheia fără firmă prinde aceeași factură venită cu altă firmă", () => {
  const inBaza = cheiaFacturii("CSHM", 3322, "");
  assert.strictEqual(cheiaFacturii("CSHM", "3322", ""), inBaza);
  assert.strictEqual(cheiaFacturii("cshm", "03322", ""), inBaza, "zerourile din față și literele mici sunt același număr");
});

test("cheia cu firmă NU le prinde — de-aia a fost nevoie de a doua pază", () => {
  assert.notStrictEqual(
    cheiaFacturii("CSHM", 3322, 1),
    cheiaFacturii("CSHM", 3322, 2),
    "dacă astea ar fi egale, bugul n-ar fi existat niciodată și testul n-ar avea sens"
  );
});

test("serii diferite rămân facturi diferite", () => {
  assert.notStrictEqual(cheiaFacturii("CSHM", 1080, ""), cheiaFacturii("WHA", 1080, ""));
  assert.notStrictEqual(cheiaFacturii("CSHM", 3322, ""), cheiaFacturii("CSHMUPA", 3322, ""));
});

test("numele firmei se potrivește oricum ar fi scrisă forma juridică", () => {
  // „CASH MACHINE S.R.L." din SmartBill trebuie să ajungă la „Cash Machine
  // SRL" din tabela de firme. Altfel lotul cade pe firma implicită — ceea ce
  // pentru Warehouse All înseamnă facturi puse pe firma greșită.
  const cheieFirma = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  assert.strictEqual(cheieFirma("CASH MACHINE S.R.L."), cheieFirma("Cash Machine SRL"));
  assert.strictEqual(cheieFirma("WAREHOUSE ALL S.R.L."), cheieFirma("Warehouse All SRL"));
  assert.notStrictEqual(cheieFirma("Cash Machine SRL"), cheieFirma("Warehouse All SRL"));
  const sursa = fs.readFileSync(path.join(__dirname, "modules", "punte.js"), "utf8");
  assert.ok(sursa.includes("cheieFirma"), "potrivirea firmei s-a întors la textul brut");
});

test("ingestFacturi chiar folosește a doua pază", () => {
  // Citim sursa: regula e ușor de scris și ușor de șters din greșeală la o
  // refactorizare. Dacă dispare, testul trebuie să cadă, nu să treacă.
  const sursa = fs.readFileSync(path.join(__dirname, "modules", "punte.js"), "utf8");
  assert.ok(sursa.includes("peSerieNumar"), "paza pe serie+număr a dispărut din ingestFacturi");
  assert.ok(sursa.includes("serie_la_alta_firma"), "lotul nu mai raportează câte facturi au venit cu altă firmă");
});

console.log(`\n${treceri} verificări trecute.`);
