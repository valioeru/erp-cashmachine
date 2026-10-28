"use strict";
// Service worker-ul ține style.css în buzunar. Dacă foaia de stil se schimbă
// și versiunea lui nu, nimeni nu vede schimbarea.
//
// CE S-A ÎNTÂMPLAT, 28.10.2026: am adăugat insigna neagră pentru comenzile
// livrate, am urcat pe GitHub, am dat deploy. Pagina venea tot cu foaia
// veche. Am dat deploy a doua oară, cu build curat. Tot veche. Fișierul din
// commit-ul desfășurat avea schimbarea — verificat pe raw.githubusercontent.
//
// Nu era nici Render, nici Cloudflare (cf-cache-status spunea DYNAMIC, adică
// necachat). Fișierul pur și simplu nu pleca de pe server: îl servea service
// worker-ul din cache-ul „erp-v2", iar potrivirea lui e pe PATHNAME, deci
// nici „/style.css?x=123" nu-l ocolea. Avertismentul era scris în sw.js, cu
// majuscule, și tot am trecut pe lângă el — de-aia regula are acum un test,
// nu un comentariu.
//
// Regula: amprenta de sub VERSIUNE trebuie să fie a lui style.css de acum.
// Schimbi foaia → recalculezi amprenta → ridici versiunea. Testul verifică
// primele două; a treia vine de la sine, fiindcă nimeni nu scrie o amprentă
// nouă fără să se întrebe de ce.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let treceri = 0;
function test(nume, f) {
  f();
  treceri++;
  console.log("  ok —", nume);
}

const SW = fs.readFileSync(path.join(__dirname, "public", "sw.js"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "public", "style.css"));
const amprentaAcum = crypto.createHash("md5").update(CSS).digest("hex").slice(0, 8);

test("sw.js declară o versiune de cache", () => {
  assert.ok(/const VERSIUNE = "[^"]+";/.test(SW), "VERSIUNE lipsește sau și-a schimbat forma");
});

test("sw.js poartă amprenta foii de stil pe care o ține în buzunar", () => {
  assert.ok(/\/\/ amprenta style\.css: [0-9a-f]{8}/.test(SW), "lipsește linia cu amprenta");
});

test("amprenta e a foii de stil DE ACUM", () => {
  const scrisa = (SW.match(/\/\/ amprenta style\.css: ([0-9a-f]{8})/) || [])[1];
  const versiune = (SW.match(/const VERSIUNE = "([^"]+)";/) || [])[1];
  assert.strictEqual(
    scrisa,
    amprentaAcum,
    `style.css s-a schimbat (amprenta e acum ${amprentaAcum}, în sw.js scrie ${scrisa}).\n` +
      `      Ridică VERSIUNE în public/sw.js (acum e "${versiune}") și pune amprenta nouă,\n` +
      `      altfel foaia de stil veche rămâne în telefoanele care au aplicația instalată.`
  );
});

test("style.css chiar e în lista de fișiere ținute în buzunar", () => {
  // Dacă iese din listă, regula de mai sus n-ar mai avea sens — iar testul
  // ar continua să treacă, păzind nimic.
  assert.ok(/STATICE = \[[^\]]*"\/style\.css"/.test(SW), "style.css nu mai e în STATICE — regula asta nu mai e necesară");
});

test("service worker-ul tot nu ține pagini în buzunar", () => {
  // Partea care contează cel mai mult: un ERP care arată soldul de acum
  // două zile, cu aer de adevăr, e mai rău decât unul care nu se deschide.
  assert.ok(/cerere\.mode === "navigate"/.test(SW), "s-a pierdut tratarea paginilor");
  assert.ok(!/caches\.match\(cerere\)/.test(SW), "a apărut o potrivire pe cererea întreagă — pagini în cache");
  assert.ok(/if \(cerere\.method !== "GET"\) return;/.test(SW), "s-a pierdut paza pe metodele care nu sunt GET");
});

console.log(`\n${treceri} verificări trecute.`);
