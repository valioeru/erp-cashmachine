"use strict";
// „Livrare la": adresa de livrare, persoana de contact, telefonul și emailul
// de pe o comandă.
//
// CEREREA LUI VALI, 23.11.2026: „La comandă nouă să poți selecta adresa de
// livrare a partenerului, alături de persoană, nr. de telefon și email."
//
// CUM. După ce se alege clientul, cele patru câmpuri vin completate cu ale
// lui: adresa de livrare de pe fișă (sau adresa firmei, dacă e „aceeași"),
// persoana de contact, telefonul și emailul. Fiecare câmp are și o listă din
// care se alege altceva al aceluiași partener — cealaltă adresă, altă persoană
// de contact dintre cele trecute pe fișă (cu telefonul și emailul ei) — și se
// poate scrie peste, pentru o livrare care merge în alt loc sau la alt om.
//
// Ce rămâne pe comandă e TEXTUL de atunci, nu o legătură spre fișă: dacă
// partenerul își schimbă mâine adresa, comanda de ieri tot acolo a plecat.
//
// Fără bază de date, ca să se poată verifica într-un test.
const AL = require("./adresa-livrare");

const CAMPURI = [
  { nume: "livrare_adresa", eticheta: "Adresa de livrare", max: 400 },
  { nume: "livrare_contact", eticheta: "Persoană de contact", max: 120 },
  { nume: "livrare_telefon", eticheta: "Telefon", max: 60 },
  { nume: "livrare_email", eticheta: "Email", max: 160 },
];
const ETICHETE = Object.fromEntries(CAMPURI.map((c) => [c.nume, "Livrare: " + c.eticheta.charAt(0).toLowerCase() + c.eticheta.slice(1)]));

const unRand = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const cheie = (v) => AL.cheie(v);

// Adresa firmei, întregită cu localitatea și județul când lipsesc din ea.
function adresaFirmei(p) {
  const adresa = unRand(p && p.adresa);
  const bucati = [adresa];
  for (const [camp, prefix] of [["localitate", ""], ["judet", "Jud. "]]) {
    const v = unRand(p && p[camp]);
    if (v && !cheie(adresa).includes(cheie(v))) bucati.push(prefix + v);
  }
  return bucati.filter(Boolean).join(", ");
}

// Ce se poate alege pentru un partener.
//   partener: rândul din `parteneri`
//   contacte: [{ nume, functie, telefon, email }] — persoanele de pe fișa lui
//   alteAdrese: [{ denumire, adresa }] — celelalte adrese de livrare ale lui
//     (lib/adrese-livrare.js; Vali, 26.11.2026: mai multe adrese pe client)
// Întoarce { adrese: [{ text, fel }], contacte: [{ nume, telefon, email, fel }], implicit }.
function optiuni(partener, contacte, alteAdrese) {
  const p = partener || {};
  const adrese = [];
  const pune = (text, fel) => {
    const t = unRand(text);
    if (t && !adrese.some((a) => cheie(a.text) === cheie(t))) adrese.push({ text: t, fel });
  };
  // Întâi adresa la care se livrează de obicei.
  if (!AL.eIdentica(p)) pune(AL.efectiva(p), "adresa de livrare");
  pune(adresaFirmei(p), AL.eIdentica(p) ? "adresa firmei (și de livrare)" : "adresa firmei");
  for (const a of Array.isArray(alteAdrese) ? alteAdrese : []) pune(a.adresa, unRand(a.denumire) || "adresă de livrare");

  const oameni = [];
  const om = (nume, telefon, email, fel) => {
    const n = unRand(nume);
    if (!n) return;
    const gasit = oameni.find((o) => cheie(o.nume) === cheie(n));
    if (gasit) {
      // Aceeași persoană trecută de două ori: se completează ce-i lipsea.
      if (!gasit.telefon) gasit.telefon = unRand(telefon);
      if (!gasit.email) gasit.email = unRand(email);
      return;
    }
    oameni.push({ nume: n, telefon: unRand(telefon), email: unRand(email), fel });
  };
  om(p.persoana_contact, p.telefon, p.email, "de pe fișa firmei");
  for (const c of Array.isArray(contacte) ? contacte : []) om(c.nume, c.telefon, c.email, unRand(c.functie) || "persoană de contact");

  const primul = oameni[0] || { nume: "", telefon: unRand(p.telefon), email: unRand(p.email) };
  return {
    adrese,
    contacte: oameni,
    implicit: {
      livrare_adresa: adrese[0] ? adrese[0].text : "",
      livrare_contact: primul.nume,
      livrare_telefon: primul.telefon,
      livrare_email: primul.email,
    },
  };
}

// Ce vine din formular. `implicit` = ce are partenerul (din `optiuni`).
// Întoarce { ok, valori } sau { ok: false, eroare }.
//
// Un câmp care lipsește cu totul din cerere (pagină veche, comandă făcută de
// ERP) se completează cu al partenerului. Un câmp trimis gol rămâne gol: omul
// l-a șters, de pildă emailul pentru o livrare fără notificare.
function dinFormular(corp, implicit) {
  const b = corp || {};
  const im = implicit || {};
  const valori = {};
  for (const c of CAMPURI) {
    const trimis = b[c.nume] !== undefined && b[c.nume] !== null;
    const v = unRand(trimis ? b[c.nume] : im[c.nume]);
    if (v.length > c.max) return { ok: false, eroare: `„${c.eticheta}” de la livrare e prea lung (cel mult ${c.max} de semne).` };
    valori[c.nume] = v;
  }
  if (valori.livrare_email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(valori.livrare_email)) {
    return { ok: false, eroare: `Emailul de la livrare, „${valori.livrare_email}”, nu arată a adresă de email.` };
  }
  return { ok: true, valori };
}

// Ce se arată pe pagina comenzii: rândurile completate, ca text.
function randuri(comanda) {
  const c = comanda || {};
  return CAMPURI.map((f) => ({ eticheta: f.eticheta, valoare: unRand(c[f.nume]) })).filter((r) => r.valoare);
}
// Pentru istoric: toate patru într-un rând.
const text = (c) => randuri(c).map((r) => r.valoare).join(" · ");

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Blocul din formularul de comandă.
//   valori: ce e scris deja (comanda la modificare, formularul întors cu greșeli)
//   opt.completeaza: true la comanda nouă — la alegerea clientului câmpurile
//     se umplu cu ale lui; la modificare doar listele se încarcă, ce e scris rămâne.
function bloc(valori, opt) {
  const v = valori || {};
  const o = opt || {};
  const camp = (c, extra) =>
    `<label class="field"><span>${esc(c.eticheta)}</span><input type="${c.nume === "livrare_email" ? "email" : "text"}" name="${c.nume}" value="${esc(unRand(v[c.nume]))}" maxlength="${c.max}" autocomplete="off" ${extra || ""}></label>`;
  return `<fieldset class="field" data-livrare-la data-completeaza="${o.completeaza ? "1" : "0"}" style="border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px">
      <legend style="font-size:13px;padding:0 4px">Livrare la</legend>
      <div class="mic" data-livrare-la-nota style="color:var(--text-muted);margin-bottom:6px">Alege clientul: adresa de livrare, persoana de contact, telefonul și emailul lui se completează singure. Dacă are mai multe adrese de livrare, o alegi din listă; poți și scrie peste.</div>
      <label class="field" data-livrare-la-alege style="display:none"><span>Alege adresa de livrare</span><select data-livrare-la-select></select></label>
      ${camp(CAMPURI[0], 'list="livrare-la-adrese"')}
      <label data-livrare-la-tine hidden style="display:none;align-items:center;gap:8px;font-weight:400;font-size:13px;margin:-4px 0 8px">
        <input type="checkbox" name="livrare_tine_minte" value="1"${String(v.livrare_tine_minte || "") === "1" ? " checked" : ""} style="width:auto"> ține minte adresa asta la client, ca s-o poți alege și la comenzile următoare
      </label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${camp(CAMPURI[1], 'list="livrare-la-oameni"')}
        ${camp(CAMPURI[2])}
        ${camp(CAMPURI[3])}
      </div>
      <div data-livrare-la-alegeri style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
      <datalist id="livrare-la-adrese"></datalist>
      <datalist id="livrare-la-oameni"></datalist>
      <script>
        (function () {
          var cutie = document.currentScript.parentNode;
          var forma = cutie.closest("form");
          if (!forma) return;
          var completeaza = cutie.getAttribute("data-completeaza") === "1";
          var camp = function (n) { return cutie.querySelector('[name="' + n + '"]'); };
          var nota = cutie.querySelector("[data-livrare-la-nota]");
          var oameni = [];
          // Ce a scris omul cu mâna lui nu se calcă la schimbarea clientului.
          var atins = {};
          ["livrare_adresa", "livrare_contact", "livrare_telefon", "livrare_email"].forEach(function (n) {
            camp(n).addEventListener("input", function () { atins[n] = true; });
          });
          function lista(id, randuri) {
            var dl = cutie.querySelector("#" + id);
            dl.innerHTML = "";
            randuri.forEach(function (r) { var op = document.createElement("option"); op.value = r[0]; op.label = r[1]; dl.appendChild(op); });
          }
          // Aceleași alegeri și ca butoane, la vedere: lista unui câmp deja
          // completat se deschide doar după ce îl golești, iar omul nu are de
          // unde să știe că partenerul mai are o adresă sau o persoană.
          var alegeri = cutie.querySelector("[data-livrare-la-alegeri]");
          // Adresa se alege dintr-o listă (Vali, 26.11.2026: „la comandă
          // selectezi adresa de livrare"). Ultima alegere e „altă adresă":
          // câmpul de dedesubt rămâne de scris, iar bifa „ține minte" apare
          // când ce e scris nu e printre adresele clientului.
          var alege = cutie.querySelector("[data-livrare-la-alege]");
          var sel = cutie.querySelector("[data-livrare-la-select]");
          var tine = cutie.querySelector("[data-livrare-la-tine]");
          var adreseStiute = [];
          var faraSemne = function (t) { return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); };
          function potrivesteAlegerea() {
            var scris = faraSemne(camp("livrare_adresa").value);
            var gasit = -1;
            adreseStiute.forEach(function (a, i) { if (gasit < 0 && faraSemne(a.text) === scris) gasit = i; });
            sel.value = gasit >= 0 ? String(gasit) : "alta";
            var arata = adreseStiute.length > 0 && scris !== "" && gasit < 0;
            tine.hidden = !arata; tine.style.display = arata ? "flex" : "none";
            if (!arata) tine.querySelector("input").checked = false;
          }
          function listaAdrese(adrese) {
            adreseStiute = adrese || [];
            sel.innerHTML = "";
            adreseStiute.forEach(function (a, i) { var op = document.createElement("option"); op.value = String(i); op.textContent = a.fel + ": " + a.text; sel.appendChild(op); });
            var alta = document.createElement("option"); alta.value = "alta"; alta.textContent = "altă adresă — o scriu mai jos"; sel.appendChild(alta);
            alege.style.display = adreseStiute.length ? "" : "none";
            potrivesteAlegerea();
          }
          sel.addEventListener("change", function () {
            if (sel.value === "alta") { camp("livrare_adresa").value = ""; camp("livrare_adresa").focus(); }
            else if (adreseStiute[Number(sel.value)]) camp("livrare_adresa").value = adreseStiute[Number(sel.value)].text;
            atins.livrare_adresa = true;
            potrivesteAlegerea();
          });
          camp("livrare_adresa").addEventListener("input", potrivesteAlegerea);
          camp("livrare_adresa").addEventListener("change", potrivesteAlegerea);
          function butoane() {
            alegeri.innerHTML = "";
            function buton(text, titlu, laClick) {
              var bt = document.createElement("button");
              bt.type = "button"; bt.className = "btn secondary small"; bt.textContent = text; bt.title = titlu;
              bt.addEventListener("click", laClick);
              alegeri.appendChild(bt);
            }
            if (oameni.length > 1) oameni.forEach(function (x) {
              buton(x.nume, [x.fel, x.telefon, x.email].filter(Boolean).join(" · "), function () {
                camp("livrare_contact").value = x.nume; camp("livrare_telefon").value = x.telefon || ""; camp("livrare_email").value = x.email || "";
              });
            });
          }
          // Persoana aleasă din listă își aduce telefonul și emailul.
          camp("livrare_contact").addEventListener("change", function () {
            var nume = this.value.trim().toLowerCase();
            var om = oameni.filter(function (x) { return x.nume.toLowerCase() === nume; })[0];
            if (!om) return;
            camp("livrare_telefon").value = om.telefon || "";
            camp("livrare_email").value = om.email || "";
            atins.livrare_telefon = false; atins.livrare_email = false;
          });
          function incarca(id, umple) {
            if (!id) return;
            fetch("/comenzi/livrare-la.json?partener=" + encodeURIComponent(id), { credentials: "same-origin" })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (d) {
                if (!d || !d.implicit) return;
                oameni = d.contacte || [];
                lista("livrare-la-adrese", (d.adrese || []).map(function (a) { return [a.text, a.fel]; }));
                lista("livrare-la-oameni", oameni.map(function (x) { return [x.nume, [x.fel, x.telefon, x.email].filter(Boolean).join(" · ")]; }));
                butoane();
                if (umple) {
                  Object.keys(d.implicit).forEach(function (n) { if (!atins[n]) camp(n).value = d.implicit[n] || ""; });
                }
                listaAdrese(d.adrese || []);
                if (nota) nota.textContent = (d.adrese || []).length > 1 || oameni.length > 1
                  ? "Completate cu ale clientului. " + ((d.adrese || []).length > 1 ? "Are " + d.adrese.length + " adrese de livrare: alege-o din listă. " : "") + (oameni.length > 1 ? "Altă persoană de contact: din butoanele de mai jos. " : "") + "Poți și scrie peste."
                  : "Completate cu ale clientului. Poți scrie peste, pentru o livrare în alt loc sau la altă persoană.";
              })
              .catch(function () {});
          }
          // Clientul ales din căutare (lib/render.js trimite „client-ales").
          forma.addEventListener("client-ales", function (ev) {
            atins = {};
            incarca(ev.detail && ev.detail.id, true);
          });
          // Pagina deschisă cu clientul deja pus (modificare, formular întors):
          // se încarcă listele; câmpurile se umplu doar dacă sunt toate goale.
          var pus = forma.querySelector('input[name="partener_id"]');
          if (pus && pus.value) {
            var goale = ["livrare_adresa", "livrare_contact", "livrare_telefon", "livrare_email"].every(function (n) { return !camp(n).value.trim(); });
            incarca(pus.value, completeaza && goale);
          }
        })();
      </script>
    </fieldset>`;
}

module.exports = { CAMPURI, ETICHETE, adresaFirmei, optiuni, dinFormular, randuri, text, bloc };
