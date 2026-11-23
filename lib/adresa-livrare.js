"use strict";
// Adresa de livrare a partenerului.
//
// CEREREA LUI VALI, 23.11.2026: „La adăugare partener să fie și adresa de
// livrare, și o bifă că e aceeași dacă e identică cu cea de partener."
//
// CUM SE ȚINE. O singură coloană, `parteneri.adresa_livrare`. GOALĂ înseamnă
// „aceeași cu adresa partenerului" — nu se copiază adresa a doua oară: copia
// ar rămâne în urmă la prima schimbare a adresei firmei și marfa ar pleca la
// adresa veche. Scrisă, e adresa la care se duce marfa.
//
// În formular: bifa „aceeași cu adresa partenerului", bifată din start. Cât e
// bifată, câmpul adresei de livrare nu se vede și nu se scrie nimic. Debifată,
// adresa de livrare trebuie scrisă — o bifă scoasă fără adresă ar însemna
// „altă adresă, dar nu știm care". O adresă de livrare scrisă la fel ca adresa
// partenerului se ține tot ca „aceeași".
//
// Fără bază de date, ca să se poată verifica într-un test.

const ETICHETA_BIFA = "aceeași cu adresa partenerului";
const MESAJ_LIPSA = "Scrie adresa de livrare, sau bifează că e aceeași cu adresa partenerului.";

const curat = (v) => String(v == null ? "" : v).replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean).join("\n");
// Pentru comparație: fără diacritice, litere mici, fără punctuație și spații duble.
const cheie = (v) =>
  curat(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const eIdentica = (p) => curat(p && p.adresa_livrare) === "";

// Ce vine din formular.
//   corp: { livrare_identica: "1" când e bifată, adresa_livrare, adresa }
// Întoarce { ok, valoare } — valoarea de scris în coloană ("" = aceeași) —
// sau { ok: false, eroare }.
//
// Un formular care nu trimite deloc cele două câmpuri (un apel mai vechi, un
// import) lasă adresa „aceeași": lipsa câmpului nu e o debifare.
function dinFormular(corp) {
  const b = corp || {};
  const bifat = String(b.livrare_identica == null ? "" : b.livrare_identica).trim() === "1";
  if (bifat) return { ok: true, valoare: "" };
  if (b.adresa_livrare === undefined || b.adresa_livrare === null) return { ok: true, valoare: "" };
  const scris = curat(b.adresa_livrare);
  if (!scris) return { ok: false, eroare: MESAJ_LIPSA };
  if (scris.length > 400) return { ok: false, eroare: "Adresa de livrare e prea lungă (cel mult 400 de semne)." };
  if (cheie(scris) === cheie(b.adresa) && cheie(scris) !== "") return { ok: true, valoare: "" };
  return { ok: true, valoare: scris };
}

// Adresa la care se livrează: cea de livrare, altfel adresa partenerului.
// `adresaPartenerului` = textul deja întregit (cu localitate și județ), dacă îl ai.
function efectiva(p, adresaPartenerului) {
  const l = curat(p && p.adresa_livrare);
  if (l) return l.replace(/\n/g, ", ");
  return curat(adresaPartenerului != null ? adresaPartenerului : p && p.adresa).replace(/\n/g, ", ");
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Câmpul din formularul de partener: bifa și, sub ea, adresa de livrare.
//   valori: rândul partenerului sau ce a scris omul (la un formular refuzat)
function campFormular(valori) {
  const v = valori || {};
  // La un formular întors cu greșeli se păstrează ce a ales omul: bifa lui,
  // dacă a trimis-o; altfel, bifat doar când nu e nicio adresă scrisă.
  const scris = curat(v.adresa_livrare);
  const bifat = v.livrare_identica !== undefined ? String(v.livrare_identica) === "1" : scris === "";
  return `<div data-adresa-livrare>
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:2px 0 6px">
        <input type="checkbox" name="livrare_identica" value="1"${bifat ? " checked" : ""} data-livrare-identica style="width:auto">
        ${esc(ETICHETA_BIFA)}
      </label>
      <textarea name="adresa_livrare" rows="3" data-livrare-text placeholder="strada, numărul, localitatea, județul — unde se duce marfa"${bifat ? ' style="display:none"' : ""}>${esc(scris)}</textarea>
      <script>
        (function () {
          var cutie = document.currentScript.parentNode;
          var bifa = cutie.querySelector("[data-livrare-identica]");
          var text = cutie.querySelector("[data-livrare-text]");
          function potriveste() { text.style.display = bifa.checked ? "none" : ""; if (!bifa.checked) text.focus(); }
          bifa.addEventListener("change", potriveste);
        })();
      </script>
    </div>`;
}

module.exports = { ETICHETA_BIFA, MESAJ_LIPSA, curat, cheie, eIdentica, dinFormular, efectiva, campFormular };
