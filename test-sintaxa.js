"use strict";
// Toate fișierele .js din proiect se pot încărca.
//
// DE CE EXISTĂ TESTUL ĂSTA, scris după ce a picat un deploy:
//
// În română, ghilimelele se deschid cu „ și se închid cu ” (U+201D). Dar
// tastate repede, sau copiate din altă parte, se închid cu " — ASCII. Într-un
// string JavaScript delimitat tot cu ", asta îl închide la mijloc:
//
//     console.log("am scos „SC" din fata a " + n + " nume");
//                              ^ aici se termină stringul
//
// Rezultatul e un SyntaxError. Nu e prins de niciun test care rulează logica,
// fiindcă fișierul nu se poate nici măcar încărca — și dacă fișierul ăla se
// cheamă doar la pornire, totul trece verde local și cade pe Render, la
// `npm start`, după ce codul e deja urcat.
//
// S-a întâmplat de trei ori: în test-ct-palet-linii.js, în
// test-depozit-termene.js, și a treia oară în lib/curata-nume.js — acolo a
// oprit pornirea aplicației în producție.
//
// Testul ăsta încarcă fiecare fișier. Rulează în câteva secunde și prinde
// clasa întreagă de greșeli, nu doar ghilimelele.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const SARI = new Set(["node_modules", ".git", "public"]);

function fisiere(dir, adanc) {
  const out = [];
  for (const nume of fs.readdirSync(dir)) {
    if (SARI.has(nume) || nume.startsWith(".")) continue;
    const cale = path.join(dir, nume);
    const st = fs.statSync(cale);
    if (st.isDirectory()) {
      if (adanc > 0) out.push(...fisiere(cale, adanc - 1));
    } else if (nume.endsWith(".js")) {
      out.push(cale);
    }
  }
  return out;
}

let esecuri = 0;
const toate = fisiere(RAD, 2);
console.log("\nVerific " + toate.length + " fișiere .js\n");

for (const f of toate) {
  const scurt = path.relative(RAD, f);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    const mesaj = String(e.stderr || e.message).split("\n").slice(0, 4).join("\n      ");
    console.log("  ESEC   " + scurt + "\n      " + mesaj);
    esecuri++;
  }
}

// A EXISTAT AICI și un al doilea pas, care căuta „…" cu ghilimea de
// închidere ASCII. L-am scos, fiindcă nu putea face diferența între greșeală
// și cod corect. Linia asta, dintr-un test real, e perfect validă:
//
//     return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
//
// Acolo ghilimeaua ASCII chiar închide stringul, intenționat. Sintactic e
// identică cu cea care îl închide din greșeală — diferența e doar intenția,
// care nu se poate citi din text. Verificarea raporta 274 de linii, aproape
// toate corecte; un test care strigă de 274 de ori nu mai e citit, deci nu
// mai apără nimic.
//
// `node --check` de mai sus prinde exact cazurile care chiar strică ceva, și
// l-ar fi prins și pe cel care a oprit pornirea în producție. Atât ajunge.
if (esecuri) console.log("\n" + esecuri + " fișier(e) nu se încarcă.\n");
else console.log("Toate cele " + toate.length + " fișiere .js se încarcă.\n");

process.exit(esecuri ? 1 : 0);
