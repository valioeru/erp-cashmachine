"use strict";
// Regulile zonei de fișier de planificare lunară.

const assert = require("assert");
const P = require("./lib/plan-lunar");

let treceri = 0;
function test(nume, f) {
  f();
  treceri++;
  console.log("  ok —", nume);
}

const fis = (filename, octeti, contentType) => ({
  filename,
  contentType: contentType || "application/octet-stream",
  data: Buffer.alloc(octeti === undefined ? 1024 : octeti),
});

// ---- luna ----------------------------------------------------------------

test("luna curentă are forma pe care o cere restul codului", () => {
  assert.match(P.lunaCurenta(), /^\d{4}-\d{2}$/);
  assert.strictEqual(P.lunaCurenta("2026-10-27T10:00:00Z"), "2026-10");
  // Decembrie e singura lună unde o greșeală de +1 la index se vede.
  assert.strictEqual(P.lunaCurenta("2026-12-31T00:00:00Z"), "2026-12");
  assert.strictEqual(P.lunaCurenta("2026-01-01T00:00:00Z"), "2026-01");
});

test("o lună inventată e refuzată, nu depozitată", () => {
  assert.ok(P.lunaValida("2026-10"));
  assert.ok(P.lunaValida("2026-01"));
  assert.ok(P.lunaValida("2026-12"));
  assert.ok(!P.lunaValida("2026-13"), "luna 13 nu există");
  assert.ok(!P.lunaValida("2026-00"), "luna 0 nu există");
  assert.ok(!P.lunaValida("2026-1"), "o cifră nu se sortează corect lângă 2026-10");
  assert.ok(!P.lunaValida("octombrie"));
  assert.ok(!P.lunaValida(""));
  assert.ok(!P.lunaValida(null));
  assert.ok(!P.lunaValida("1999-05"), "înainte de 2020 e aproape sigur o tastare greșită");
});

test("numele lunii e pe românește și nu alunecă cu o lună", () => {
  assert.strictEqual(P.numeLuna("2026-10"), "octombrie 2026");
  assert.strictEqual(P.numeLuna("2026-01"), "ianuarie 2026");
  assert.strictEqual(P.numeLuna("2026-12"), "decembrie 2026");
});

// ---- fișierul ------------------------------------------------------------

test("primește foile de calcul și PDF-ul", () => {
  for (const ext of ["xlsx", "xls", "csv", "ods", "pdf"]) {
    const v = P.verificaFisier(fis(`plan.${ext}`), "2026-10");
    assert.ok(v.ok, `.${ext} ar trebui primit, dar: ${v.gresite.join(" ")}`);
  }
});

test("refuză ce nu e un plan, și spune ce primește", () => {
  const v = P.verificaFisier(fis("plan.exe"), "2026-10");
  assert.ok(!v.ok);
  assert.match(v.gresite[0], /\.xlsx/, "mesajul trebuie să spună ce se acceptă, nu doar că e greșit");
  assert.ok(!P.verificaFisier(fis("poza.jpg"), "2026-10").ok, "o poză nu e planul lunii");
  assert.ok(!P.verificaFisier(fis("plan"), "2026-10").ok, "fără extensie nu știm ce e");
});

test("formularul trimis gol nu trece drept fișier", () => {
  const v = P.verificaFisier(fis("plan.xlsx", 0), "2026-10");
  assert.ok(!v.ok);
  assert.match(v.gresite[0], /niciun fișier/i);
  assert.ok(!P.verificaFisier(undefined, "2026-10").ok);
  assert.ok(!P.verificaFisier({}, "2026-10").ok);
});

test("plafonul de mărime e sub limita corpului cererii", () => {
  // Dacă plafonul ar trece de 25 MB, cererea ar fi tăiată de router înainte
  // să ajungă aici, iar omul ar primi o eroare de server în loc de un mesaj.
  assert.ok(P.MAX_OCTETI < 25_000_000, "plafonul trebuie să lase loc plicului multipart");
  assert.ok(P.verificaFisier(fis("plan.xlsx", P.MAX_OCTETI), "2026-10").ok, "exact pe plafon se primește");
  const v = P.verificaFisier(fis("plan.xlsx", P.MAX_OCTETI + 1), "2026-10");
  assert.ok(!v.ok);
  assert.match(v.gresite[0], /MB/, "mesajul trebuie să spună cât are și cât se poate");
});

test("luna greșită oprește urcarea, chiar dacă fișierul e bun", () => {
  const v = P.verificaFisier(fis("plan.xlsx"), "2026-13");
  assert.ok(!v.ok);
  assert.ok(v.gresite.some((g) => /lun/i.test(g)));
});

test("mime-ul se scrie din extensie, nu se crede ce zice browserul", () => {
  // Browserele trimit des „application/octet-stream" pe xlsx. Dacă l-am
  // păstra, fișierul s-ar descărca fără pictogramă și uneori fără extensie.
  const v = P.verificaFisier(fis("plan.xlsx", 1024, "application/octet-stream"), "2026-10");
  assert.strictEqual(v.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

// ---- numele din Drive ----------------------------------------------------

test("numele din Drive începe cu luna și păstrează extensia", () => {
  const n = P.numeInDrive("2026-10", "Plan producție octombrie.xlsx", "2026-10-27T15:40:00Z");
  assert.ok(n.startsWith("2026-10-"), n);
  assert.ok(n.endsWith(".xlsx"), n);
  assert.ok(!/[ăâîșț ]/i.test(n), `fără diacritice și fără spații: ${n}`);
});

test("două versiuni din aceeași zi nu se calcă", () => {
  const a = P.numeInDrive("2026-10", "plan.xlsx", "2026-10-27T09:00:00Z");
  const b = P.numeInDrive("2026-10", "plan.xlsx", "2026-10-27T17:30:00Z");
  assert.notStrictEqual(a, b);
});

test("un nume numai din diacritice nu dă un fișier fără nume", () => {
  const n = P.numeInDrive("2026-10", "ăîș.xlsx", "2026-10-27T09:00:00Z");
  assert.ok(/2026-10-.+\.xlsx$/.test(n), n);
  assert.ok(!n.includes("--"), `nu rămâne cu liniuțe goale: ${n}`);
});

// ---- gruparea pe luni ----------------------------------------------------

test("cea mai nouă versiune e cea curentă, restul sunt istorie", () => {
  const g = P.grupeazaPeLuna([
    { id: 1, luna: "2026-10", nume_fisier: "v1.xlsx" },
    { id: 2, luna: "2026-10", nume_fisier: "v2.xlsx" },
    { id: 3, luna: "2026-10", nume_fisier: "v3.xlsx" },
  ]);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].curent.nume_fisier, "v3.xlsx");
  assert.deepStrictEqual(g[0].vechi.map((v) => v.nume_fisier), ["v2.xlsx", "v1.xlsx"]);
});

test("lunile vin cu cea mai recentă sus, oricum ar veni din bază", () => {
  const g = P.grupeazaPeLuna([
    { id: 1, luna: "2026-09" },
    { id: 2, luna: "2026-11" },
    { id: 3, luna: "2026-10" },
  ]);
  assert.deepStrictEqual(g.map((x) => x.luna), ["2026-11", "2026-10", "2026-09"]);
});

test("ordinea pe id, nu pe dată — două urcări în aceeași minută", () => {
  const g = P.grupeazaPeLuna([
    { id: 7, luna: "2026-10", incarcat_la: "2026-10-27 15:40:00", nume_fisier: "prima.xlsx" },
    { id: 8, luna: "2026-10", incarcat_la: "2026-10-27 15:40:00", nume_fisier: "a doua.xlsx" },
  ]);
  assert.strictEqual(g[0].curent.nume_fisier, "a doua.xlsx");
});

test("nicio lună, nicio grupă — și nu crapă", () => {
  assert.deepStrictEqual(P.grupeazaPeLuna([]), []);
  assert.deepStrictEqual(P.grupeazaPeLuna(null), []);
  assert.deepStrictEqual(P.grupeazaPeLuna([{ id: 1 }]), [], "un rând fără lună nu are unde să stea");
});

// ---- mărimea -------------------------------------------------------------

test("mărimea se citește dintr-o privire", () => {
  assert.strictEqual(P.marimeOmeneasca(512), "512 B");
  assert.strictEqual(P.marimeOmeneasca(2048), "2 KB");
  assert.strictEqual(P.marimeOmeneasca(3 * 1024 * 1024), "3,0 MB");
  assert.strictEqual(P.marimeOmeneasca(0), "0 B");
  assert.strictEqual(P.marimeOmeneasca(null), "0 B");
});

console.log(`\n${treceri} verificări trecute.`);
