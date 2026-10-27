"use strict";
// Cursul oficial BNR: citirea fișierului lor și socoteala în lei.
//
// BNR publică zilnic, la https://www.bnr.ro/nbrfxrates.xml, un XML cu cursul
// de referință. Aici e doar CITIREA lui și aritmetica — fără rețea și fără
// bază de date, ca să poată fi verificate de test. Aducerea fișierului stă în
// modules/curs.js.
//
// DE CE NU FOLOSIM UN parser XML:
//   Fișierul are formă fixă de douăzeci de ani și vreo patruzeci de rânduri.
//   O dependință în plus, pentru atât, s-ar strica mai des decât fișierul.

// Cursul unei singure monede, din XML.
//
// CAPCANA, și singurul motiv pentru care funcția asta merită un test:
// unele monede sunt cotate la 100 de unități, nu la una —
// `<Rate currency="HUF" multiplier="100">1.2345</Rate>` înseamnă 100 de
// forinți, nu unul. Cine ignoră `multiplier` iese de o sută de ori pe lângă.
// La euro nu se vede, fiindcă n-are multiplicator — deci greșeala ar sta
// ascunsă până în ziua în care cineva adaugă prima monedă cu el.
function parseaza(xml) {
  const text = String(xml || "");
  // Tolerant la cum arata fisierul:
  //   • prefix de spatiu de nume („<ns:Cube"), daca BNR schimba vreodata
  //     serializarea;
  //   • ghilimele simple sau duble;
  //   • alte atribute inainte de „date".
  // Nu e peste masura de generos: tot cere un element Cube cu o data valida
  // si randuri Rate cu moneda pe trei litere. Un raspuns HTML (pagina de
  // eroare sau de blocare) nu trece.
  // Fișierul zilei are un singur Cube; cel cu zece zile are zece. Îl luăm pe
  // cel cu data cea mai mare, nu pe primul din fișier: ordinea lor nu e
  // promisă nicăieri, iar un curs de acum nouă zile scris pe o comandă de azi
  // n-ar da nicio eroare — ar da doar o sumă greșită, care arată bine.
  let cube = null;
  for (const c of text.matchAll(
    /<(?:[\w.-]+:)?Cube\b[^>]*\bdate=["'](\d{4}-\d{2}-\d{2})["'][^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Cube>/g
  )) {
    if (!cube || c[1] > cube[1]) cube = c;
  }
  if (!cube) return null;
  const data = cube[1];
  const cursuri = {};
  for (const m of cube[2].matchAll(/<(?:[\w.-]+:)?Rate\b[^>]*\bcurrency=["']([A-Za-z]{3})["']([^>]*)>([^<]+)<\/(?:[\w.-]+:)?Rate>/g)) {
    const moneda = m[1].toUpperCase();
    const atribute = m[2] || "";
    const brut = Number(String(m[3]).trim());
    if (!isFinite(brut) || brut <= 0) continue;
    const mult = atribute.match(/multiplier=["'](\d+)["']/);
    const impartitor = mult ? Number(mult[1]) : 1;
    if (!isFinite(impartitor) || impartitor <= 0) continue;
    cursuri[moneda] = brut / impartitor;
  }
  if (!Object.keys(cursuri).length) return null;
  return { data, cursuri };
}

// Câți lei fac `suma` în `moneda`, la cursul dat.
//
// Se rotunjește la bani ABIA la final, nu pe fiecare linie: altfel o comandă
// de o sută de linii ar ieși cu câțiva bani pe lângă totalul calculat
// altundeva, iar cineva ar căuta diferența o după-amiază.
function inLei(suma, moneda, curs) {
  const s = Number(suma);
  if (!isFinite(s)) return 0;
  const m = String(moneda || "RON").toUpperCase();
  if (m === "RON") return s;
  const c = Number(curs);
  if (!isFinite(c) || c <= 0) return 0;
  return s * c;
}

// Cursul se scrie cu patru zecimale, cum îl publică BNR. Cu două, 4,9723 ar
// deveni 4,97 — iar la o comandă de 50.000 € înseamnă 115 lei diferență.
function scrieCurs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "";
  return n.toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

// Prețul unitar: până la patru zecimale, dar fără zerouri degeaba.
//
// Cererea lui Vali, 27.10.2026. Un preț de 0,4235 lei pe pungă nu încape în
// două zecimale — la 500.000 de bucăți, rotunjirea la 0,42 pierde 1.750 de
// lei pe o singură linie. Dar un preț de 23,50 nu trebuie scris „23,5000".
function scriePret(v) {
  const n = Number(v);
  if (!isFinite(n)) return "0,00";
  const cuPatru = Math.round(n * 10000) / 10000;
  const zecimale = Number.isInteger(cuPatru * 100) ? 2 : 4;
  return cuPatru.toLocaleString("ro-RO", { minimumFractionDigits: zecimale, maximumFractionDigits: zecimale });
}

// Totalurile se scriu mereu cu două zecimale: sunt bani de încasat, nu prețuri
// unitare.
function scrieSuma(v) {
  return (Number(v) || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Textul de sub totalul unei comenzi în altă monedă.
//
// Când cursul lipsește, NU se inventează unul și nu se tace: se spune că
// lipsește. O cifră în lei scoasă dintr-un curs ghicit arată exact ca una
// adevărată, și pe aia o trece cineva mai departe.
function explica(total, moneda, curs, dataCursului) {
  const m = String(moneda || "RON").toUpperCase();
  if (m === "RON") return "";
  if (!(Number(curs) > 0)) {
    return "Cursul BNR nu a putut fi luat, deci nu scriem echivalentul în lei — o cifră ghicită ar arăta la fel cu una adevărată.";
  }
  const lei = inLei(total, m, curs);
  return `≈ ${scrieSuma(lei)} lei, la cursul BNR ${scrieCurs(curs)}${dataCursului ? " din " + dataCursului : ""}`;
}

// Adresa fișierului BNR.
//
// 27.10.2026: era „www.bnr.ro/nbrfxrates.xml", adresa clasică de douăzeci de
// ani. BNR a mutat fișierele pe curs.bnr.ro, iar vechea adresă NU dă 404 — te
// trimite pe pagina lor de start. Adică cererea reușea, întorcea 119 KB de
// HTML, și singurul semn că ceva e greșit era că nu ieșea niciun curs.
// De-aia citirea refuză o pagină HTML în loc să caute cifre prin ea.
const ADRESA = "https://curs.bnr.ro/nbrfxrates.xml";

// Dacă fișierul zilei nu e încă publicat (BNR îl pune pe la 13:00), ăsta are
// ultimele zece zile — deci tot scoate cursul de ieri, nu nimic.
const ADRESA_REZERVA = "https://curs.bnr.ro/nbrfxrates10days.xml";

module.exports = { parseaza, inLei, scrieCurs, scriePret, scrieSuma, explica, ADRESA, ADRESA_REZERVA };
