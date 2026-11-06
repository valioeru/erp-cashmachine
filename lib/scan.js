"use strict";
// Codurile de bare ale ERP-ului: ce scrie în fiecare și cum se citește înapoi
// un cod scanat. Fără bază de date, ca să se poată verifica într-un test;
// căutarea propriu-zisă stă în modules/scan.js.
//
// CE A CERUT VALI, 05.11.2026: „Să fie și cod de bare pe orice aviz sau
// etichetă, să poți scana produsul. Codul de bare e asociat cu fiecare cod de
// produs, comandă, AWB etc."
//
// Cititorul de coduri e, pentru calculator, o tastatură: „tastează" codul și
// dă Enter. Tot ce primește ERP-ul e deci un text, iar din text trebuie să
// reiasă ce e. Fiecare document are forma lui:
//
//   produs               codul din nomenclator, neschimbat;
//                        produsul fără cod: P-<id>
//   comandă de client    CMD-<id>
//   aviz                 <serie>-<număr>          CHMA-1389
//   palet CT-Park        CT<aallzz>-<nnnn>        (de pe eticheta paletului)
//   lot de producție     CM-<aallzz>-<id>         (de pe fișa de lot)
//   operație             CMP<id>.<nnn>            (de pe fișa de lot)
//   comandă la furnizor  CF-<an>-<nnnn>           (chiar numărul ei)
//   AWB                  numărul, cum îl tipărește curierul
//
// De ce CMD-<id> și nu numărul comenzii: numărul îl scrie omul (de obicei e
// numărul de comandă al clientului), poate lipsi, se poate repeta la doi
// clienți și poate conține orice. Id-ul e unic și nu se schimbă. Numărul
// clientului se recunoaște și el la scanare, dacă vine pe hârtia clientului.
//
// Formele se pot totuși suprapune — un cod de produs poate arăta ca un aviz.
// De-aia căutarea nu se oprește la prima formă potrivită: le încearcă pe toate,
// iar dacă ies mai multe lucruri, omul alege din listă.

const { curat } = require("./codbare");

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const intreg = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Codul de pe bare al unui produs: codul lui, iar fără cod, id-ul. Primește
// codul și id-ul PRODUSULUI separat, nu un rând întreg — pe o linie de aviz
// „id" e id-ul liniei, și un cod făcut din el ar duce la alt produs.
function codProdus(cod, produsId) {
  const c = text(cod);
  if (c) return c;
  const id = intreg(produsId);
  return id ? "P-" + id : "";
}

function codComanda(id) {
  const n = intreg(id);
  return n ? "CMD-" + n : "";
}

// „CHMA" + 1389 → „CHMA-1389". Seria doar cu litere mari și cifre: un spațiu
// sau o diacritică s-ar citi, dar n-ar mai da înapoi seria scrisă în ERP.
function codAviz(serie, numar) {
  const s = curat(serie).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const n = intreg(numar);
  return s && n ? `${s}-${n}` : "";
}

// Ce a „tastat" cititorul, fără ce n-are ce căuta într-un cod. Unele cititoare
// pun în față identificatorul de simbologie („]C0" la Code 128), altele lasă
// la coadă un caracter de control; omul care scrie de mână lasă spații.
function curataScanat(brut) {
  return String(brut === null || brut === undefined ? "" : brut)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\][A-Za-z][0-9A-Za-z]/, "")
    .trim()
    .slice(0, 80);
}

// Ce poate fi un text scanat. Întoarce { text, forme }, formele în ordinea în
// care merită arătate. Nu exclude nimic: „CMD-142" e întâi comanda 142, dar
// poate fi și codul unui produs — dacă există, apar amândouă.
function interpreteaza(brut) {
  const t = curataScanat(brut);
  const forme = [];
  if (!t) return { text: "", forme };
  const sus = t.toUpperCase();
  let m;
  if ((m = sus.match(/^CMD-?(\d{1,9})$/))) forme.push({ fel: "comanda", id: Number(m[1]) });
  if (/^CT\d{6}-\d{1,9}$/.test(sus)) forme.push({ fel: "palet", cod: sus });
  if (/^CF-\d{4}-\d{1,9}$/.test(sus)) forme.push({ fel: "comanda_furnizor", numar: sus });
  if ((m = sus.match(/^CM-(\d{6})-(\d{1,9})$/))) forme.push({ fel: "productie", id: Number(m[2]), lot: sus });
  if ((m = sus.match(/^CMP(\d{1,9})\.(\d{1,4})$/))) forme.push({ fel: "productie", id: Number(m[1]), operatie: Number(m[2]) });
  if ((m = sus.match(/^P-(\d{1,9})$/))) forme.push({ fel: "produs_id", id: Number(m[1]) });
  if ((m = sus.match(/^([A-Z]{1,10})[- ]?(\d{1,9})$/))) forme.push({ fel: "aviz", serie: m[1], numar: Number(m[2]) });
  // Oricare text poate fi codul unui produs, numărul de comandă scris de
  // client sau lotul de pe un palet.
  forme.push({ fel: "produs", cod: t });
  if (t.length >= 2) forme.push({ fel: "numar_comanda", numar: t });
  forme.push({ fel: "lot", lot: t });
  // AWB: doar litere și cifre. Pe eticheta coletului, codul de bare are la
  // coadă numărul coletului („…001"), deci se caută și fără ultimele trei
  // cifre — la fel ca la scanarea retururilor din fulfillment.
  if (/^[A-Z0-9]{8,40}$/.test(sus)) {
    forme.push({ fel: "awb", awb: sus, expeditie: sus.length > 11 && /\d{3}$/.test(sus) ? sus.slice(0, -3) : null });
  }
  return { text: t, forme };
}

// ---------------------------------------------------------------------------
// SCANAREA DE ORIUNDE
//
// Omul cu cititorul în mână nu caută întâi pagina de scanare: scanează eticheta
// de pe palet și vrea să vadă paletul. Scriptul de mai jos stă pe fiecare
// pagină din ERP și recunoaște cititorul după viteză: el „tastează" un cod
// întreg în câteva zeci de milisecunde și dă Enter, omul nu. Un șir de cel
// puțin patru caractere venit așa, terminat cu Enter (sau Tab, la cititoarele
// setate așa), deschide /scan cu el.
//
// NU se amestecă deloc cât timp e ceva de scris pe pagină — un câmp, o listă,
// un text editabil. Acolo codul intră în câmp, cum intra și până acum; așa
// merg mai departe căutările și scanarea retururilor din fulfillment.
const PRAG_INTRE_TASTE = 100; // ms: mai rar de atât, e om
const PRAG_MEDIU = 60; // ms pe caracter, în medie, de la primul la Enter
const LUNGIME_MINIMA = 4;

function scriptScaner() {
  return `<script>
(function () {
  var sir = "", primul = 0, ultimul = 0;
  function deScris(el) {
    if (!el || el === document.body) return false;
    var t = String(el.tagName || "").toUpperCase();
    return Boolean(el.isContentEditable) || t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey || deScris(ev.target) || deScris(document.activeElement)) { sir = ""; return; }
    var acum = Date.now();
    if (sir && acum - ultimul > ${PRAG_INTRE_TASTE}) sir = "";
    ultimul = acum;
    if (ev.key === "Enter" || ev.key === "Tab") {
      var cod = sir;
      sir = "";
      if (cod.length >= ${LUNGIME_MINIMA} && acum - primul <= cod.length * ${PRAG_MEDIU}) {
        ev.preventDefault();
        window.location.href = "/scan?cod=" + encodeURIComponent(cod);
      }
      return;
    }
    if (ev.key && ev.key.length === 1) {
      if (!sir) primul = acum;
      sir += ev.key;
    }
  }, true);
})();
</script>`;
}

module.exports = {
  codProdus,
  codComanda,
  codAviz,
  curataScanat,
  interpreteaza,
  scriptScaner,
  PRAG_INTRE_TASTE,
  PRAG_MEDIU,
  LUNGIME_MINIMA,
};
