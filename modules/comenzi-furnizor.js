"use strict";
// Comenzi către furnizor — hârtia care pleacă afară, nu cererea internă.
//
// CE ERA ÎNAINTE și de ce nu ajungea: `aprovizionari` e ce cere depozitul
// („îmi lipsesc 300 kg de granulă"). Un produs, fără preț, fără furnizor, fără
// document. Bun ca semnal, inutil ca și comandă: nu poți trimite nimănui o
// listă de lipsuri și nu poți ști peste trei luni cât ai plătit și cine a
// întârziat. Procurement ține OFERTELE (cine cât cere). Între ofertă și
// recepție lipsea tocmai comanda.
//
// CE FACE pagina asta, în cuvintele lui Vali: „înregistrare și trimitere
// comandă furnizor ptr materii prime … se trimite de pe contul
// comercial@cashmachine.ro … dacă nu există să îl pot adăuga printr-un click
// … rămân comenzile în curs sau livrate cu data solicitată și data recepție …
// istoric preț … filtre pe toate astea plus suma totală comandată".
//
// Și, din 05.11.2026: „să poți adăuga moneda și schimb la curs pus de noi, să
// se calculeze și în RON automat și în EUR dacă moneda standard e RON, buton
// de export PDF și de modificare ulterioară. Dacă se modifică ceva rămâne în
// istoric cine a modificat ce și când."
//
// DECIZII care se văd peste tot în fișier:
//
//   • ISTORICUL DE PREȚ NU ARE TABELĂ PROPRIE. Istoricul sunt chiar liniile
//     comenzilor vechi. O a doua tabelă ar începe să mintă din prima zi în
//     care cineva corectează o linie și uită de ea.
//
//   • LINIA POATE SĂ N-AIBĂ PRODUS DIN NOMENCLATOR. Materia primă pe care n-ai
//     cumpărat-o încă nu are cum să fie în nomenclator; dacă aș cere obligatoriu
//     un produs, omul ar inventa unul ca să treacă de formular, iar nomenclatorul
//     s-ar umple de fantome. Denumirea scrisă de mână e de ajuns; produsul, când
//     există, leagă comanda de istoricul de preț și de stoc.
//
//   • CURSUL E AL COMENZII. Se propune BNR-ul din ziua comenzii, dar se scrie
//     pe comandă cel pus de om, și de acolo nu se mai mișcă singur. Socoteala
//     e în lib/comenzi-furnizor-logica.js, cu testul ei.
//
//   • ISTORICUL MODIFICĂRILOR NU SE ȘTERGE ȘI NU SE CORECTEAZĂ. Fiecare rând
//     ține numele omului copiat în clipa scrierii, nu doar legătura: peste doi
//     ani omul poate fi plecat din firmă, iar „modificat de (nimeni)" nu apără
//     pe nimeni.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const mail = require("../lib/mail");
const L = require("../lib/comenzi-furnizor-logica");
const PDF = require("../lib/comanda-furnizor-pdf");

// Adresa de pe care pleacă, cerută explicit. Rămâne schimbabilă din formular
// pentru cine are și alte căsuțe — lib/mail verifică singur dacă are voie.
const EXPEDITOR = "comercial@cashmachine.ro";

const MONEDE = ["RON", "EUR", "USD"];
const UNITATI = ["kg", "buc", "ml", "mp", "tonă", "rolă", "palet", "set", "litru", "oră"];

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// Ziua și ora din România. `toISOString()`, folosit aici înainte, dă ora UTC:
// în istoric, „cine a modificat și când" cu două ore pe lângă e un răspuns
// greșit, iar între miezul nopții și ora 2 și ziua ar fi cea de ieri.
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const acum = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).replace("T", " ").slice(0, 19);
const text = (v) => String(v === null || v === undefined ? "" : v).trim();
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const eData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Numărul cu zecimale, scris ca în România. Nu `money()`: acolo scrie „lei",
// iar jumătate din comenzile astea sunt în euro.
function sumaCu(v, moneda) {
  return nr(v).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (moneda || "RON");
}

// „2026-11-05 13:20:11" → „05.11.2026 13:20".
function cand(v) {
  const s = String(v || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!m) return s;
  return `${m[3]}.${m[2]}.${m[1]}${m[4] ? " " + m[4] : ""}`;
}

// Ce se scrie într-un câmp de formular: virgulă, fără puncte de mii, fără
// zerouri de umplutură — „1,51", „28", „0,4235".
function campNumar(v, zecimale) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string") return v; // ce a tastat omul, întors neatins
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(zecimale).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

// Cine are voie să înregistreze și să trimită comenzi. Pagina stă sub zona
// /procurement, deci accesul e deja filtrat de lib/auth; aici se verifică doar
// ce e ireversibil — trimiterea unui email și anularea unei comenzi.
function poateTrimite(user) {
  return Boolean(user && (user.rol === "admin" || user.rol === "depozit" || user.rol === "financiar"));
}

// Cine poate modifica o comandă după ce a fost salvată: cine poate s-o și
// trimită, plus omul care a scris-o — el știe ce a vorbit cu furnizorul.
function poateModifica(user, c) {
  if (!user || !c) return false;
  if (poateTrimite(user)) return true;
  return Boolean(c.creata_de) && Number(c.creata_de) === Number(user.id);
}

const badgeStatus = (s) => {
  const culoare = { ciorna: "", trimisa: "albastru", confirmata: "albastru", partial: "galben", primita: "verde", anulata: "rosu" }[s] || "";
  return `<span class="badge ${culoare}">${esc(L.STATUS_ETICHETA[s] || s)}</span>`;
};

async function liniile(comandaId) {
  return db
    .prepare(
      `SELECT l.*, p.cod AS produs_cod, p.denumire AS produs_denumire
         FROM comenzi_furnizor_linii l
         LEFT JOIN produse p ON p.id = l.produs_id
        WHERE l.comanda_id = ? ORDER BY l.id`
    )
    .all(comandaId);
}

async function comandaCuFurnizor(id) {
  return db
    .prepare(
      `SELECT c.*, p.nume AS furnizor, p.email AS furnizor_email, p.cui AS furnizor_cui, p.adresa AS furnizor_adresa,
              u.nume AS creata_nume, um.nume AS modificata_nume
         FROM comenzi_furnizor c
         LEFT JOIN parteneri p ON p.id = c.furnizor_id
         LEFT JOIN utilizatori u ON u.id = c.creata_de
         LEFT JOIN utilizatori um ON um.id = c.modificata_de
        WHERE c.id = ?`
    )
    .get(id);
}

// ---------------------------------------------------------------------------
// Monedele și cursul BNR.

// Monedele din care se poate alege: cele trei obișnuite sus, apoi tot ce
// publică BNR (GBP, CHF, PLN, HUF, CNY…). Aurul și DST-ul FMI nu sunt monede în
// care se plătește o factură. Moneda unei comenzi vechi rămâne în listă chiar
// dacă BNR n-o mai publică, altfel formularul de modificare ar schimba-o tăcut.
async function monedeDisponibile(curenta) {
  const r = await db.prepare("SELECT DISTINCT moneda FROM cursuri_bnr ORDER BY moneda").all().catch(() => []);
  const toate = [...MONEDE];
  for (const x of r || []) {
    const m = String((x && x.moneda) || "").toUpperCase();
    if (/^[A-Z]{3}$/.test(m) && m !== "XAU" && m !== "XDR" && !toate.includes(m)) toate.push(m);
  }
  const c = String(curenta || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(c) && !toate.includes(c)) toate.push(c);
  return toate;
}

// Cursul BNR al fiecărei monede la o zi. Dacă ziua lipsește (weekend,
// sărbătoare, BNR n-a publicat încă) se ia ultima zi de DINAINTE, cum face și
// contabilitatea — niciodată cursul de după, care la data comenzii nu exista.
async function cursuriBnr(data) {
  const r = await db
    .prepare("SELECT DISTINCT ON (moneda) moneda, valoare, data FROM cursuri_bnr WHERE data <= ? ORDER BY moneda, data DESC")
    .all(eData(data) ? data : azi())
    .catch(() => []);
  const o = {};
  for (const x of r || []) {
    const v = Number(x.valoare);
    if (v > 0) o[String(x.moneda).toUpperCase()] = { valoare: v, data: String(x.data || "").slice(0, 10) };
  }
  return o;
}

// Cursurile cu care se socotește o comandă, cu BNR-ul zilei ei acolo unde pe
// comandă nu e scris niciunul (comenzile de dinainte de 05.11.2026). Se spune
// de unde vine fiecare, ca pagina să nu dea drept „pus de noi" un curs pe
// care nu l-a pus nimeni.
async function cursulEfectiv(c) {
  const moneda = String((c && c.moneda) || "RON").toUpperCase();
  const bnr = await cursuriBnr(String((c && c.data) || azi()).slice(0, 10));
  let curs = moneda === "RON" ? 1 : nr(c.curs) > 0 ? nr(c.curs) : null;
  let dinBnr = false;
  if (moneda !== "RON" && !curs && bnr[moneda]) {
    curs = bnr[moneda].valoare;
    dinBnr = true;
  }
  let cursEur = moneda === "EUR" ? curs : nr(c.curs_eur) > 0 ? nr(c.curs_eur) : null;
  let eurDinBnr = moneda === "EUR" ? dinBnr : false;
  if (moneda !== "EUR" && !cursEur && bnr.EUR) {
    cursEur = bnr.EUR.valoare;
    eurDinBnr = true;
  }
  return { moneda, curs, cursEur, dinBnr, eurDinBnr, bnr };
}

// ---------------------------------------------------------------------------
// Istoricul: cine a schimbat ce și când.
//
// Dacă scrierea istoricului cade, cade toată cererea — nu e prinsă în
// try/catch. O comandă schimbată fără urmă e exact ce s-a cerut să nu existe.
async function scrieIstoric(comandaId, user, schimbari) {
  if (!schimbari || !schimbari.length) return 0;
  const la = acum();
  for (const s of schimbari) {
    await db
      .prepare(
        `INSERT INTO comenzi_furnizor_istoric (comanda_id, utilizator_id, utilizator_nume, ce, vechi, nou, la)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        comandaId,
        user ? user.id : null,
        user ? user.nume || user.email || "" : "",
        String(s.ce || "").slice(0, 300),
        s.vechi === null || s.vechi === undefined || s.vechi === "" ? null : String(s.vechi).slice(0, 2000),
        s.nou === null || s.nou === undefined || s.nou === "" ? null : String(s.nou).slice(0, 2000),
        la
      );
  }
  return schimbari.length;
}

async function citesteIstoric(comandaId) {
  return db
    .prepare("SELECT * FROM comenzi_furnizor_istoric WHERE comanda_id = ? ORDER BY id DESC LIMIT 300")
    .all(comandaId)
    .catch(() => []);
}

// Ultimul preț plătit pe fiecare produs, din liniile comenzilor de dinainte.
// DISTINCT ON e al Postgresului și face exact ce trebuie: un rând pe produs,
// cel mai recent. Comenzile anulate nu intră — un preț dintr-o comandă anulată
// n-a fost niciodată plătit.
async function ultimelePreturi() {
  try {
    const r = await db
      .prepare(
        `SELECT DISTINCT ON (l.produs_id)
                l.produs_id, l.pret_unitar, l.um, c.moneda, c.data, COALESCE(p.nume, '') AS furnizor
           FROM comenzi_furnizor_linii l
           JOIN comenzi_furnizor c ON c.id = l.comanda_id
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
          WHERE l.produs_id IS NOT NULL AND l.pret_unitar IS NOT NULL AND c.status <> 'anulata'
          ORDER BY l.produs_id, c.data DESC, c.id DESC`
      )
      .all();
    const m = new Map();
    for (const x of r) m.set(Number(x.produs_id), x);
    return m;
  } catch (e) {
    return new Map();
  }
}

// Istoricul de preț al unui produs: toate liniile de pe comenzile vechi.
async function istoricProdus(produsId, exclude) {
  if (!produsId) return [];
  return db
    .prepare(
      `SELECT l.pret_unitar, l.cantitate, l.um, c.id AS comanda_id, c.numar, c.data, c.moneda, c.status,
              COALESCE(p.nume, '—') AS furnizor
         FROM comenzi_furnizor_linii l
         JOIN comenzi_furnizor c ON c.id = l.comanda_id
         LEFT JOIN parteneri p ON p.id = c.furnizor_id
        WHERE l.produs_id = ? AND c.status <> 'anulata' AND c.id <> ?
        ORDER BY c.data DESC, c.id DESC LIMIT 12`
    )
    .all(produsId, exclude || 0);
}

// ---------------------------------------------------------------------------
// Alegerea produsului pe linie: un singur <datalist> pentru tot formularul.
//
// De ce nu lista derulantă scrisă de mână, ca la comenzile de client: aia a
// trebuit reparată o dată pentru că `position:absolute` o tăia la câțiva pixeli
// în celula de tabel. <datalist> e al browserului, nu se taie niciodată, caută
// singur în timp ce scrii și — important aici — lasă omul să scrie o denumire
// care nu există în nomenclator, ceea ce la materie primă e cazul obișnuit.
function datalistProduse(produse, preturi) {
  const date = produse.map((p) => {
    const u = preturi.get(Number(p.id));
    return [
      p.id,
      (p.cod ? p.cod + " · " : "") + p.denumire,
      p.unitate_masura || "buc",
      p.categorie || "",
      u ? nr(u.pret_unitar) : null,
      u ? u.moneda : "",
      u ? String(u.data).slice(0, 10) : "",
      u ? u.furnizor : "",
    ];
  });
  const categorii = [...new Set(produse.map((p) => text(p.categorie)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ro"));
  return `
    <datalist id="cf-produse"></datalist>
    <script>
    var CF_PRODUSE = ${JSON.stringify(date).replace(/</g, "\\u003c")};
    var CF_CATEGORII = ${JSON.stringify(categorii).replace(/</g, "\\u003c")};
    var CF_DUPA_ETICHETA = {};
    CF_PRODUSE.forEach(function (p) { CF_DUPA_ETICHETA[p[1].toLowerCase()] = p; });

    // Lista se reconstruiește doar când se schimbă categoria. Cu toate
    // produsele deodată ar fi mii de noduri în pagină la fiecare tastă.
    function cfUmpleLista(categorie) {
      var dl = document.getElementById("cf-produse");
      var html = "";
      var puse = 0;
      for (var i = 0; i < CF_PRODUSE.length && puse < 1200; i++) {
        var p = CF_PRODUSE[i];
        if (categorie && p[3] !== categorie) continue;
        html += '<option value="' + String(p[1]).replace(/"/g, "&quot;") + '">';
        puse++;
      }
      dl.innerHTML = html;
    }

    // Ce se întâmplă când omul a ales un produs: se completează unitatea și,
    // dacă n-a scris deja un preț, ultimul preț plătit — ca propunere, nu ca
    // adevăr. Scrie dedesubt de când e și de la cine, ca să se vadă dacă mai
    // are vreo legătură cu realitatea. Prețul se propune doar dacă a fost în
    // aceeași monedă: 1,51 € pus pe o comandă în lei ar fi de cinci ori mai mic.
    function cfLeagaRand(rand) {
      var inp = rand.querySelector(".cf-produs");
      if (!inp || inp.dataset.legat) return;
      inp.dataset.legat = "1";
      inp.addEventListener("input", function () {
        var p = CF_DUPA_ETICHETA[String(inp.value || "").toLowerCase()];
        var ascuns = rand.querySelector(".cf-produs-id");
        var um = rand.querySelector(".cf-um");
        var pret = rand.querySelector(".cf-pret");
        var nota = rand.querySelector(".cf-nota");
        var sel = document.getElementById("cf-moneda");
        var moneda = sel ? sel.value : "";
        if (!p) { if (ascuns) ascuns.value = ""; if (nota) nota.textContent = ""; return; }
        if (ascuns) ascuns.value = p[0];
        if (um && !um.value) um.value = p[2];
        if (p[4] !== null && p[4] !== undefined) {
          if (pret && !pret.value && (!p[5] || !moneda || p[5] === moneda)) pret.value = String(p[4]).replace(".", ",");
          if (nota) nota.textContent = "ultima dată " + String(p[4]).replace(".", ",") + " " + p[5] + " la " + p[6] + (p[7] ? " de la " + p[7] : "");
        } else if (nota) {
          nota.textContent = "n-a mai fost comandat prin ERP";
        }
      });
    }

    // Rândul nou vine dintr-un <template>, nu dintr-o copie a primului rând:
    // pe pagina de modificare primul rând e o poziție existentă, cu ID-ul ei,
    // cu cât s-a primit din ea și cu bifa de ștergere — nimic din astea nu
    // are ce căuta pe o poziție nouă.
    function cfRandNou() {
      var corp = document.getElementById("cf-linii");
      var sablon = document.getElementById("cf-rand-sablon");
      var rand;
      if (sablon && sablon.content && sablon.content.firstElementChild) {
        rand = sablon.content.firstElementChild.cloneNode(true);
      } else {
        rand = corp.querySelector("tr").cloneNode(true);
        rand.querySelectorAll("input").forEach(function (i) { i.value = ""; delete i.dataset.legat; });
        var n = rand.querySelector(".cf-nota"); if (n) n.textContent = "";
      }
      corp.appendChild(rand);
      cfLeagaRand(rand);
    }

    document.addEventListener("DOMContentLoaded", function () {
      var sel = document.getElementById("cf-categorie");
      if (sel) {
        CF_CATEGORII.forEach(function (c) {
          var o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o);
        });
        sel.addEventListener("change", function () { cfUmpleLista(sel.value); });
      }
      cfUmpleLista("");
      document.querySelectorAll("#cf-linii tr").forEach(cfLeagaRand);
      var b = document.getElementById("cf-adauga");
      if (b) b.addEventListener("click", cfRandNou);
    });
    </script>`;
}

// Cursul și totalul, socotite în pagină în timp ce omul scrie — același
// calcul ca pe server (lib/comenzi-furnizor-logica.js), ca să nu vadă o cifră
// în formular și alta după salvare.
//
// Câmpul de curs se completează cu BNR-ul doar cât timp omul nu l-a atins.
// Odată scris de mână, rămâne al lui: schimbarea datei comenzii nu-i mai
// suprascrie cursul negociat.
function scriptCurs(bnr) {
  return `
    <script>
    var CF_BNR = ${JSON.stringify(bnr || {}).replace(/</g, "\\u003c")};
    (function () {
      function nrCamp(v) {
        var t = String(v === null || v === undefined ? "" : v).replace(/\\s+/g, "");
        if (t === "") return null;
        if (!/^(\\d+([.,]\\d*)?|[.,]\\d+)$/.test(t)) return NaN;
        return Number(t.replace(",", "."));
      }
      function bani(x) { return Math.round(Number((x * 100).toPrecision(12))) / 100; }
      function scrie(x) { return x.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
      function scrieCurs(x) { return x.toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 6, useGrouping: false }); }
      var sel, campCurs, curs, eur, notaCurs, notaEur, total, data;
      function moneda() { return sel ? sel.value : "RON"; }
      function nota(el, m, input) {
        if (!el || !input) return;
        var b = CF_BNR[m];
        if (!b) { el.textContent = "BNR n-are curs " + m + " la data comenzii — scrie-l voi."; return; }
        var v = nrCamp(input.value);
        var html = "BNR " + b.data.split("-").reverse().join(".") + ": " + scrieCurs(b.valoare);
        if (v && !isNaN(v) && Math.abs(v - b.valoare) > 0.0000005) {
          var ab = Math.round(((v - b.valoare) / b.valoare) * 1000) / 10;
          html += " · al vostru " + (ab > 0 ? "+" : "") + String(ab).replace(".", ",") + "%";
          if (Math.abs(ab) > 10) html = '<span style="color:var(--danger,#b3261e)">' + html + " — verificați cursul</span>";
          html += ' · <a href="#" data-bnr="' + (input === curs ? "curs" : "eur") + '">pune BNR</a>';
        }
        el.innerHTML = html;
      }
      function etichete() {
        var m = moneda();
        if (campCurs) campCurs.style.display = m === "RON" || m === "EUR" ? "none" : "";
        document.querySelectorAll(".cf-m").forEach(function (s) { s.textContent = m; });
        var rost = document.getElementById("cf-rost-eur");
        if (rost) rost.textContent = m === "EUR" ? "din el iese valoarea în lei" : m === "RON" ? "din el iese valoarea în euro" : "din el iese echivalentul în euro";
      }
      function propune() {
        var m = moneda();
        if (curs && !curs.dataset.atins) curs.value = m !== "RON" && m !== "EUR" && CF_BNR[m] ? scrieCurs(CF_BNR[m].valoare) : "";
        if (eur && !eur.dataset.atins) eur.value = CF_BNR.EUR ? scrieCurs(CF_BNR.EUR.valoare) : "";
      }
      function socoteste() {
        var m = moneda(), suma = 0, fara = 0, gresit = 0;
        document.querySelectorAll("#cf-linii tr").forEach(function (r) {
          var st = r.querySelector(".cf-sterge");
          if (st && st.checked) return;
          var den = String((r.querySelector(".cf-produs") || {}).value || "").trim();
          var q = nrCamp((r.querySelector(".cf-cant") || {}).value);
          var p = nrCamp((r.querySelector(".cf-pret") || {}).value);
          if (!den && q === null) return;
          if (q === null || isNaN(q) || (p !== null && isNaN(p))) { gresit++; return; }
          if (p === null) { fara++; return; }
          suma += bani(p * q);
        });
        suma = bani(suma);
        var c = m === "RON" ? 1 : m === "EUR" ? nrCamp(eur && eur.value) : nrCamp(curs && curs.value);
        var ce = m === "EUR" ? c : nrCamp(eur && eur.value);
        var parti = ["Total: <strong>" + scrie(suma) + " " + m + "</strong>"];
        if (m !== "RON") parti.push(c && !isNaN(c) ? "= " + scrie(bani(suma * c)) + " lei" : "în lei: lipsește cursul");
        if (m !== "EUR") parti.push(c && ce && !isNaN(c) && !isNaN(ce) ? "= " + scrie(bani((suma * c) / ce)) + " EUR" : "în euro: lipsește cursul");
        if (fara) parti.push(fara + (fara === 1 ? " poziție" : " poziții") + " fără preț");
        if (gresit) parti.push('<span style="color:var(--danger,#b3261e)">' + gresit + (gresit === 1 ? " poziție" : " poziții") + " cu cantitatea sau prețul scrise greșit</span>");
        if (total) total.innerHTML = parti.join(" · ");
        if (m !== "RON" && m !== "EUR") nota(notaCurs, m, curs); else if (notaCurs) notaCurs.textContent = "";
        nota(notaEur, "EUR", eur);
      }
      document.addEventListener("DOMContentLoaded", function () {
        sel = document.getElementById("cf-moneda");
        campCurs = document.getElementById("cf-camp-curs");
        curs = document.getElementById("cf-curs");
        eur = document.getElementById("cf-curs-eur");
        notaCurs = document.getElementById("cf-nota-curs");
        notaEur = document.getElementById("cf-nota-eur");
        total = document.getElementById("cf-total");
        data = document.querySelector("input[name=data]");
        if (!sel) return;
        [curs, eur].forEach(function (i) {
          if (i) i.addEventListener("input", function () { i.dataset.atins = "1"; socoteste(); });
        });
        sel.addEventListener("change", function () {
          // Cursul de dolari nu are ce căuta pe o comandă trecută în lire.
          if (curs) delete curs.dataset.atins;
          etichete(); propune(); socoteste();
        });
        document.addEventListener("input", function (e) {
          if (e.target && e.target.closest && e.target.closest("#cf-linii")) socoteste();
        });
        document.addEventListener("change", function (e) {
          if (e.target && e.target.classList && e.target.classList.contains("cf-sterge")) socoteste();
        });
        document.addEventListener("click", function (e) {
          var a = e.target && e.target.closest ? e.target.closest("a[data-bnr]") : null;
          if (!a) return;
          e.preventDefault();
          var peCurs = a.getAttribute("data-bnr") === "curs";
          var i = peCurs ? curs : eur;
          var m = peCurs ? moneda() : "EUR";
          if (i && CF_BNR[m]) { i.value = scrieCurs(CF_BNR[m].valoare); delete i.dataset.atins; socoteste(); }
        });
        if (data) data.addEventListener("change", function () {
          if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(data.value)) return;
          fetch("/procurement/comenzi/curs.json?data=" + encodeURIComponent(data.value), { credentials: "same-origin" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.cursuri) { CF_BNR = j.cursuri; propune(); socoteste(); } })
            .catch(function () {});
        });
        etichete(); propune(); socoteste();
      });
    })();
    </script>`;
}

// Un rând din tabelul de poziții. `l` vine din bază (pagina de modificare)
// sau din ce a trimis omul (formularul întors cu eroare) — de-aia numerele
// pot fi și text, și se scriu înapoi exact cum le-a tastat.
function randLinie(l, modificare) {
  const x = l || {};
  const primit = nr(x.cantitate_primita);
  const areId = Boolean(x.id);
  return `
      <tr>
        <td>
          <input class="cf-produs" list="cf-produse" name="denumire[]" value="${esc(x.denumire || "")}" placeholder="scrie sau alege din nomenclator" autocomplete="off">
          <input type="hidden" class="cf-produs-id" name="produs_id[]" value="${esc(x.produs_id || "")}">
          ${modificare ? `<input type="hidden" name="linie_id[]" value="${esc(areId ? x.id : "")}">` : ""}
          <div class="cf-nota"></div>
        </td>
        <td><input class="cf-cant" name="cantitate[]" value="${esc(campNumar(x.cantitate, 3))}" inputmode="decimal" autocomplete="off"></td>
        <td><input class="cf-um" name="um[]" value="${esc(x.um || "")}" list="cf-unitati" autocomplete="off"></td>
        <td><input class="cf-pret" name="pret_unitar[]" value="${esc(campNumar(x.pret_unitar, 4))}" inputmode="decimal" autocomplete="off" placeholder="opțional"></td>
        ${
          modificare
            ? `<td class="cf-primit">${
                primit > 0 ? `${esc(primit.toLocaleString("ro-RO", { maximumFractionDigits: 3 }))} ${esc(x.um || "")}` : '<span style="color:var(--text-muted)">—</span>'
              }</td>
        <td class="cf-del">${
          areId
            ? primit > 0
              ? '<span title="A intrat deja marfă pe ea — se poate schimba cantitatea, nu se poate șterge" style="color:var(--text-muted);font-size:12px">are marfă</span>'
              : `<input type="checkbox" class="cf-sterge" name="sterge_id[]" value="${esc(x.id)}" aria-label="șterge poziția"${x.sters ? " checked" : ""}>`
            : ""
        }</td>`
            : ""
        }
      </tr>`;
}

// Formularul comenzii: același pentru comandă nouă și pentru modificare.
//
// o.mod        — "nou" sau "modifica"
// o.c          — capul comenzii (valorile de pus în câmpuri)
// o.linii      — pozițiile
// o.atins      — { curs, eur }: câmpurile de curs scrise deja de om, pe care
//                BNR-ul nu le mai suprascrie
function formularComanda(o) {
  const c = o.c || {};
  const modificare = o.mod === "modifica";
  const moneda = String(c.moneda || "RON").toUpperCase();
  const linii = (o.linii && o.linii.length ? o.linii : [{}, {}, {}]).slice();
  if (!modificare) while (linii.length < 3) linii.push({});
  // Lățimile coloanelor se dau o singură dată, în <colgroup>, iar câmpurile
  // umplu celula. Înainte fiecare câmp avea lățimea lui scrisă de mână, iar
  // tabelul n-avea clasa tabelelor din ERP — rândurile ieșeau decalate
  // (raportat de Vali cu poză, 05.11.2026).
  const coloane = modificare
    ? '<tr><th>Produs / denumire</th><th class="cf-num">Cantitate</th><th>UM</th><th class="cf-num">Preț unitar (<span class="cf-m">' + esc(moneda) + '</span>)</th><th>Primit</th><th class="cf-del">Șterge</th></tr>'
    : '<tr><th>Produs / denumire</th><th class="cf-num">Cantitate</th><th>UM</th><th class="cf-num">Preț unitar (<span class="cf-m">' + esc(moneda) + "</span>)</th></tr>";
  const latimi = modificare ? [40, 13, 12, 15, 12, 8] : [50, 16, 14, 20];
  const cursAltaMoneda = moneda !== "RON" && moneda !== "EUR" ? c.curs : "";
  const cursEur = moneda === "EUR" ? (c.curs_eur !== undefined && c.curs_eur !== null && c.curs_eur !== "" ? c.curs_eur : c.curs) : c.curs_eur;
  const atins = o.atins || {};
  const scrieCursCamp = (v) => (typeof v === "string" ? v : L.scrieCurs(v));

  return `
      <form class="form" method="post" action="${esc(o.actiune)}" style="max-width:980px">
        <h2>Către cine</h2>
        <div style="display:grid;grid-template-columns:${modificare ? "1fr" : "3fr auto"};gap:12px;align-items:end">
          <label class="field"><span>Furnizor</span>
            <select name="furnizor_id" required>
              <option value="">— alege —</option>
              ${o.furnizori
                .map((f) => `<option value="${f.id}"${Number(c.furnizor_id) === Number(f.id) ? " selected" : ""}>${esc(f.nume)}${f.email ? " · " + esc(f.email) : ""}</option>`)
                .join("")}
            </select>
          </label>
          ${modificare ? "" : `<button type="button" class="btn secondary" id="cf-buton-furnizor-nou" onclick="cfDeschideFurnizor()">+ Furnizor nou</button>`}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>Data comenzii</span><input type="date" name="data" value="${esc(String(c.data || azi()).slice(0, 10))}" required></label>
          <label class="field"><span>Data solicitată de livrare</span><input type="date" name="data_solicitata" value="${esc(String(c.data_solicitata || "").slice(0, 10))}"></label>
        </div>

        <h2>Moneda și cursul</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;align-items:start">
          <label class="field"><span>Moneda comenzii</span>
            <select name="moneda" id="cf-moneda">${o.monede.map((m) => `<option value="${m}"${m === moneda ? " selected" : ""}>${m}</option>`).join("")}</select>
          </label>
          <label class="field" id="cf-camp-curs"${moneda === "RON" || moneda === "EUR" ? ' style="display:none"' : ""}><span>Curs <b class="cf-m">${esc(moneda)}</b> — lei pentru 1 <b class="cf-m">${esc(moneda)}</b></span>
            <input name="curs" id="cf-curs" value="${esc(scrieCursCamp(cursAltaMoneda))}" inputmode="decimal" autocomplete="off"${atins.curs ? ' data-atins="1"' : ""}>
            <small id="cf-nota-curs" style="display:block;font-size:12px;color:var(--text-muted);margin-top:3px"></small>
          </label>
          <label class="field"><span>Curs EUR — lei pentru 1 EUR</span>
            <input name="curs_eur" id="cf-curs-eur" value="${esc(scrieCursCamp(cursEur))}" inputmode="decimal" autocomplete="off"${atins.eur ? ' data-atins="1"' : ""}>
            <small id="cf-nota-eur" style="display:block;font-size:12px;color:var(--text-muted);margin-top:3px"></small>
          </label>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:0">
          Cursul îl puneți voi — cel negociat cu banca sau cu furnizorul. Se propune cursul BNR din ziua comenzii;
          dacă lăsați câmpul gol, se ia BNR-ul. Cursul EUR: <span id="cf-rost-eur"></span>.
          Rămâne scris pe comandă și nu se mai schimbă singur când se mișcă cursul.
        </p>

        <h2>Ce comandăm</h2>
        <label class="field" style="max-width:380px"><span>Filtrează produsele pe categorie</span>
          <select id="cf-categorie"><option value="">toate categoriile</option></select>
        </label>
        <style>
          .cf-tabel { table-layout: fixed; min-width: 640px; }
          .cf-tabel th { padding: 9px 10px; vertical-align: bottom; }
          .cf-tabel td { padding: 8px 10px; vertical-align: top; }
          .cf-tabel input:not([type=checkbox]):not([type=hidden]) {
            width: 100%; box-sizing: border-box; min-width: 0; margin: 0;
            font-family: inherit; font-size: 14px; padding: 8px 10px;
            border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: #fff;
          }
          .cf-tabel .cf-cant, .cf-tabel .cf-pret, .cf-tabel th.cf-num { text-align: right; }
          .cf-tabel .cf-nota { font-size: 12px; color: var(--text-muted); min-height: 15px; margin-top: 3px; }
          .cf-tabel td.cf-primit { padding-top: 17px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .cf-tabel .cf-del { text-align: center; }
          .cf-tabel td.cf-del { padding-top: 16px; font-size: 12px; color: var(--text-muted); }
          .cf-tabel td.cf-del input { width: 18px; height: 18px; margin: 0; }
        </style>
        <div class="tabel-scroll">
        <table class="table cf-tabel">
          <colgroup>${latimi.map((w) => `<col style="width:${w}%">`).join("")}</colgroup>
          <thead>${coloane}</thead>
          <tbody id="cf-linii">${linii.map((l) => randLinie(l, modificare)).join("")}</tbody>
        </table>
        </div>
        <template id="cf-rand-sablon">${randLinie({}, modificare).trim()}</template>
        <p><button type="button" class="btn small secondary" id="cf-adauga">+ Încă o poziție</button></p>
        <div id="cf-total" class="detail-box" style="margin:6px 0 14px;font-size:14px" aria-live="polite"></div>

        <label class="field"><span>Observații pentru furnizor (intră în email și în PDF; orarul de descărcare, luni – vineri 09:00 – 17:30, se pune singur)</span><textarea name="observatii" rows="2" placeholder="ex. livrare la Afumați, în intervalul 8–16">${esc(c.observatii || "")}</textarea></label>

        ${
          modificare
            ? `<label class="field"><span>De ce modifici? (intră în istoric, opțional)</span>
          <input type="text" name="motiv" maxlength="200" value="${esc(o.motiv || "")}" placeholder="ex. furnizorul a confirmat alt preț">
        </label>
        <div class="form-actions">
          <button class="btn" type="submit">Salvează modificările</button>
          <a href="/procurement/comenzi/${esc(c.id)}" class="btn secondary">Renunță</a>
        </div>`
            : `<div class="form-actions">
          <button class="btn" type="submit" name="actiune" value="salveaza">Salvează comanda</button>
          <a href="/procurement/comenzi" class="btn secondary">Renunță</a>
        </div>
        <p style="font-size:12px;color:var(--text-muted)">
          Se salvează ca ciornă. Emailul către furnizor se trimite din pagina comenzii, după ce îl vezi scris.
        </p>`
        }
      </form>`;
}

// Ce a trimis formularul, citit și verificat. Același pentru comandă nouă și
// pentru modificare.
//
// La prima greșeală întoarce { eroare: cod } — „furnizor", „linii",
// „cantitate", „pret", „curs". Altfel { antet, linii }, unde fiecare linie
// păstrată are `id`-ul ei, iar cele noi au id null.
function citesteFormular(b, monede) {
  const furnizorId = parseInt(b.furnizor_id, 10) || null;
  if (!furnizorId) return { eroare: "furnizor" };

  const ids = asArray(b["linie_id[]"]);
  const denumiri = asArray(b["denumire[]"]);
  const produse = asArray(b["produs_id[]"]);
  const cantitati = asArray(b["cantitate[]"]);
  const unitati = asArray(b["um[]"]);
  const preturi = asArray(b["pret_unitar[]"]);
  const sterse = new Set(asArray(b["sterge_id[]"]).map((x) => String(parseInt(x, 10))));

  const linii = [];
  for (let i = 0; i < denumiri.length; i++) {
    const id = parseInt(ids[i], 10) || null;
    if (id && sterse.has(String(id))) continue; // bifată „șterge"
    const den = text(denumiri[i]);
    const cantText = text(cantitati[i]);
    if (!den && !cantText) continue; // rând gol, lăsat de formular (sau golit dinadins)
    // O denumire fără cantitate e o greșeală de completare, nu o comandă de
    // zero bucăți. Se spune omului, nu se salvează tăcut.
    const cant = L.numarDinCamp(cantText, 3);
    if (!den || !cant.ok || !(cant.valoare > 0)) return { eroare: "cantitate", linie: den };
    // Prețul gol e „de confirmat", nu zero. Prețul scris greșit e o greșeală
    // spusă omului — înainte se transforma tăcut în „fără preț".
    const pret = L.numarDinCamp(text(preturi[i]), 4);
    if (!pret.ok) return { eroare: "pret", linie: den };
    linii.push({
      id,
      produs_id: parseInt(produse[i], 10) || null,
      denumire: den.slice(0, 300),
      cantitate: cant.valoare,
      um: text(unitati[i]).slice(0, 20) || null,
      pret_unitar: pret.valoare,
    });
  }
  if (!linii.length) return { eroare: "linii" };

  const moneda = monede.includes(text(b.moneda).toUpperCase()) ? text(b.moneda).toUpperCase() : "RON";
  const cursM = L.cursDinCamp(b.curs);
  const cursE = L.cursDinCamp(b.curs_eur);
  if ((moneda !== "RON" && moneda !== "EUR" && !cursM.ok) || !cursE.ok) return { eroare: "curs" };

  const antet = {
    furnizor_id: furnizorId,
    data: eData(text(b.data).slice(0, 10)) ? text(b.data).slice(0, 10) : azi(),
    data_solicitata: eData(text(b.data_solicitata).slice(0, 10)) ? text(b.data_solicitata).slice(0, 10) : null,
    moneda,
    curs: moneda === "RON" ? null : moneda === "EUR" ? cursE.valoare : cursM.valoare,
    curs_eur: cursE.valoare,
    observatii: text(b.observatii) || null,
  };
  return { antet, linii };
}

// Cursurile lăsate goale se iau de la BNR, din ziua comenzii. Ce nu are nici
// BNR-ul rămâne gol — pagina spune atunci că lipsește, nu inventează unul.
async function completeazaCursuri(antet) {
  const bnr = await cursuriBnr(antet.data);
  if (antet.moneda === "RON") antet.curs = null;
  else if (!antet.curs && bnr[antet.moneda]) antet.curs = bnr[antet.moneda].valoare;
  if (antet.moneda === "EUR") antet.curs_eur = antet.curs;
  else if (!antet.curs_eur && bnr.EUR) antet.curs_eur = bnr.EUR.valoare;
  return bnr;
}

const MESAJE_EROARE = {
  furnizor: "Alege un furnizor sau adaugă-l cu butonul de lângă.",
  linii: "O comandă fără nicio poziție cu denumire și cantitate n-are ce trimite.",
  cantitate: "O poziție are denumire dar n-are cantitate (sau cantitatea nu e un număr). Scrie cantitatea sau șterge rândul.",
  pret: "Un preț nu e un număr. Scrie-l cu virgulă sau cu punct, fără puncte de mii — de exemplu 1250,50.",
  curs: "Cursul nu e un număr pozitiv. Scrie-l ca la BNR, de exemplu 5,0912 — sau lasă câmpul gol și se ia cursul BNR.",
  primita: "",
};

function register(router) {
  // ---- lista, cu filtre pe tot ce s-a cerut ------------------------------
  router.get("/procurement/comenzi", async (ctx) => {
    const q = ctx.query || {};
    const cauta = text(q.q);
    const furnizorId = parseInt(q.furnizor, 10) || null;
    const statusAles = text(q.status);
    const deLa = text(q.de_la).slice(0, 10);
    const panaLa = text(q.pana_la).slice(0, 10);
    const solDeLa = text(q.sol_de_la).slice(0, 10);
    const recDeLa = text(q.rec_de_la).slice(0, 10);

    const unde = [];
    const args = [];
    if (furnizorId) {
      unde.push("c.furnizor_id = ?");
      args.push(furnizorId);
    }
    if (statusAles === "deschise") unde.push("c.status IN ('ciorna','trimisa','confirmata','partial')");
    else if (statusAles === "primite") unde.push("c.status IN ('primita','partial')");
    else if (statusAles && L.STATUS_ETICHETA[statusAles]) {
      unde.push("c.status = ?");
      args.push(statusAles);
    }
    if (deLa) {
      unde.push("c.data >= ?");
      args.push(deLa);
    }
    if (panaLa) {
      unde.push("c.data <= ?");
      args.push(panaLa);
    }
    if (solDeLa) {
      unde.push("c.data_solicitata >= ?");
      args.push(solDeLa);
    }
    if (recDeLa) {
      unde.push("c.data_receptie >= ?");
      args.push(recDeLa);
    }
    // Căutarea prinde și numărul comenzii, și numele furnizorului, și ce scrie
    // pe linii — omul își amintește „aia cu granula", nu numărul ei.
    if (cauta) {
      unde.push(
        `(c.numar ILIKE ? OR COALESCE(p.nume,'') ILIKE ? OR EXISTS (
            SELECT 1 FROM comenzi_furnizor_linii l WHERE l.comanda_id = c.id AND l.denumire ILIKE ?))`
      );
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }

    // Cursul fiecărei comenzi: cel scris pe ea; la comenzile de dinainte de
    // 05.11.2026, care n-au niciunul, BNR-ul din ziua lor.
    const comenzi = await db
      .prepare(
        `SELECT c.*, COALESCE(p.nume, '—') AS furnizor, u.nume AS creata_nume,
                (SELECT COUNT(*) FROM comenzi_furnizor_linii l WHERE l.comanda_id = c.id) AS nr_linii,
                (SELECT COALESCE(SUM(l.cantitate * l.pret_unitar), 0) FROM comenzi_furnizor_linii l
                  WHERE l.comanda_id = c.id AND l.pret_unitar IS NOT NULL) AS total,
                (SELECT COUNT(*) FROM comenzi_furnizor_linii l
                  WHERE l.comanda_id = c.id AND l.pret_unitar IS NULL) AS fara_pret,
                COALESCE(c.curs, (SELECT b.valoare FROM cursuri_bnr b
                                   WHERE b.moneda = UPPER(c.moneda) AND b.data <= COALESCE(NULLIF(c.data, ''), '9999-12-31')
                                   ORDER BY b.data DESC LIMIT 1)) AS curs_ef,
                COALESCE(c.curs_eur, (SELECT b.valoare FROM cursuri_bnr b
                                   WHERE b.moneda = 'EUR' AND b.data <= COALESCE(NULLIF(c.data, ''), '9999-12-31')
                                   ORDER BY b.data DESC LIMIT 1)) AS curs_eur_ef
           FROM comenzi_furnizor c
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
           LEFT JOIN utilizatori u ON u.id = c.creata_de
          ${unde.length ? "WHERE " + unde.join(" AND ") : ""}
          ORDER BY c.data DESC, c.id DESC
          LIMIT 500`
      )
      .all(...args);

    const furnizori = await db
      .prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 3000")
      .all();

    const valabile = comenzi.filter((x) => x.status !== "anulata");
    const peMoneda = L.totaluriPeMoneda(valabile);
    const echivalent = (x) => L.echivalente(nr(x.total), { moneda: x.moneda, curs: x.curs_ef, curs_eur: x.curs_eur_ef });
    let totalLei = 0;
    let totalEur = 0;
    let faraCurs = 0;
    for (const x of valabile) {
      const e = echivalent(x);
      if (e.ron === null || e.eur === null) faraCurs++;
      if (e.ron !== null) totalLei += e.ron;
      if (e.eur !== null) totalEur += e.eur;
    }
    totalLei = L.BANI(totalLei);
    totalEur = L.BANI(totalEur);
    const deschise = comenzi.filter((x) => L.DESCHISE.includes(x.status));
    const intarziate = deschise.filter((x) => x.data_solicitata && String(x.data_solicitata).slice(0, 10) < azi());

    const randuri = comenzi.map((x) => {
      const intr = L.intarziere(x.data_solicitata, x.data_receptie);
      const m = String(x.moneda || "RON").toUpperCase();
      const e = echivalent(x);
      const sub = [];
      if (m !== "RON") sub.push(e.ron === null ? "lei: fără curs" : sumaCu(e.ron, "lei"));
      if (m !== "EUR") sub.push(e.eur === null ? "EUR: fără curs" : sumaCu(e.eur, "EUR"));
      return [
        `<a href="/procurement/comenzi/${x.id}"><strong>${esc(x.numar || "#" + x.id)}</strong></a>`,
        esc(String(x.data || "").slice(0, 10)),
        esc(x.furnizor),
        badgeStatus(x.status),
        String(x.nr_linii),
        `<strong>${esc(sumaCu(x.total, m))}</strong>` +
          (nr(x.total) > 0 && sub.length ? `<br><span style="font-size:12px;color:var(--text-muted)">= ${esc(sub.join(" · "))}</span>` : "") +
          (nr(x.fara_pret) ? `<br><span style="font-size:12px;color:var(--text-muted)">+${esc(x.fara_pret)} fără preț</span>` : ""),
        x.data_solicitata
          ? esc(String(x.data_solicitata).slice(0, 10)) +
            (!x.data_receptie && String(x.data_solicitata).slice(0, 10) < azi() && L.DESCHISE.includes(x.status)
              ? ' <span class="badge rosu">depășit</span>'
              : "")
          : '<span style="color:var(--text-muted)">—</span>',
        x.data_receptie
          ? esc(String(x.data_receptie).slice(0, 10)) +
            (intr === null ? "" : ` <span style="font-size:12px;color:var(--text-muted)">${intr > 0 ? "+" + intr + " zile" : intr === 0 ? "la timp" : intr + " zile"}</span>`)
          : '<span style="color:var(--text-muted)">—</span>',
      ];
    });

    const body = `
      <div class="toolbar">
        <a href="/procurement/comenzi/noua" class="btn">+ Comandă nouă</a>
        <a href="/procurement/comenzi/preturi" class="btn secondary">Istoric prețuri</a>
        <a href="/procurement" class="btn secondary">Oferte de la furnizori</a>
      </div>

      <form class="filtre" method="get" action="/procurement/comenzi">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="număr, furnizor sau produs" style="min-width:240px">
        <select name="furnizor">
          <option value="">toți furnizorii</option>
          ${furnizori.map((f) => `<option value="${f.id}"${furnizorId === f.id ? " selected" : ""}>${esc(f.nume)}</option>`).join("")}
        </select>
        <select name="status">
          <option value="">toate stările</option>
          <option value="deschise"${statusAles === "deschise" ? " selected" : ""}>în curs</option>
          <option value="primite"${statusAles === "primite" ? " selected" : ""}>primite (și parțial)</option>
          ${Object.keys(L.STATUS_ETICHETA).map((s) => `<option value="${s}"${statusAles === s ? " selected" : ""}>${esc(L.STATUS_ETICHETA[s])}</option>`).join("")}
        </select>
        <label style="font-size:13px">data comenzii <input type="date" name="de_la" value="${esc(deLa)}"> – <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
        <label style="font-size:13px">solicitată după <input type="date" name="sol_de_la" value="${esc(solDeLa)}"></label>
        <label style="font-size:13px">recepție după <input type="date" name="rec_de_la" value="${esc(recDeLa)}"></label>
        <button class="btn small" type="submit">Filtrează</button>
        <a class="btn small secondary" href="/procurement/comenzi">Golește</a>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Comenzi în filtru</div><div class="value">${comenzi.length}</div></div>
        <div class="card"><div class="label">În curs</div><div class="value">${deschise.length}</div></div>
        <div class="card"><div class="label">Cu termen depășit</div><div class="value">${intarziate.length}</div></div>
        <div class="card"><div class="label">Total comandat</div><div class="value">${esc(
          [...peMoneda.entries()].map(([m, v]) => sumaCu(v, m)).join(" + ") || "0,00 RON"
        )}</div></div>
        <div class="card"><div class="label">Total în lei</div><div class="value">${esc(sumaCu(totalLei, "lei"))}</div><div class="label">la cursul fiecărei comenzi</div></div>
        <div class="card"><div class="label">Total în euro</div><div class="value">${esc(sumaCu(totalEur, "EUR"))}</div>${
          faraCurs ? `<div class="label">${faraCurs} ${faraCurs === 1 ? "comandă" : "comenzi"} fără curs, nesocotite</div>` : ""
        }</div>
      </div>

      ${
        comenzi.length
          ? `<div class="tabel-scroll">${table(
              ["Număr", "Data", "Furnizor", "Stare", "Poziții", "Valoare", "Solicitată", "Recepție"],
              randuri
            )}</div>`
          : `<p>Nicio comandă în filtrul ales. <a href="/procurement/comenzi/noua">Înregistrează prima</a>.</p>`
      }

      <p style="font-size:12px;color:var(--text-muted)">
        Lei și euro sunt la cursul scris pe fiecare comandă; unde nu e scris niciunul (comenzile mai vechi), la cursul BNR din ziua comenzii.
        Comenzile anulate nu intră în totaluri. Nu sunt sume contabile.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comenzi către furnizori", active: "/procurement/comenzi", body }));
  });

  // ---- istoricul de preț, pe produs --------------------------------------
  router.get("/procurement/comenzi/preturi", async (ctx) => {
    const cauta = text((ctx.query || {}).q);
    const unde = ["c.status <> 'anulata'", "l.pret_unitar IS NOT NULL"];
    const args = [];
    if (cauta) {
      unde.push("(l.denumire ILIKE ? OR COALESCE(p.nume,'') ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`);
    }
    const linii = await db
      .prepare(
        `SELECT l.denumire, l.produs_id, l.pret_unitar, l.cantitate, l.um,
                c.id AS comanda_id, c.numar, c.data, c.moneda, COALESCE(p.nume,'—') AS furnizor
           FROM comenzi_furnizor_linii l
           JOIN comenzi_furnizor c ON c.id = l.comanda_id
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
          WHERE ${unde.join(" AND ")}
          ORDER BY LOWER(l.denumire), c.data DESC, c.id DESC
          LIMIT 1500`
      )
      .all(...args);

    // Gruparea pe produs: pe produs_id când există, altfel pe denumirea scrisă.
    // Două linii scrise diferit rămân două rânduri — și e bine așa: pretinsa
    // potrivire pe text ar lipi „granulă PP" de „granulă PP reciclat".
    const grupe = new Map();
    for (const l of linii) {
      const cheie = l.produs_id ? "p" + l.produs_id : "t" + text(l.denumire).toLowerCase();
      if (!grupe.has(cheie)) grupe.set(cheie, []);
      grupe.get(cheie).push(l);
    }

    const blocuri = [...grupe.values()]
      .filter((g) => g.length)
      .map((g) => {
        const ultima = g[0];
        const variatie = (() => {
          const aceeasiMoneda = g.filter((x) => x.moneda === ultima.moneda);
          if (aceeasiMoneda.length < 2) return "";
          const prima = aceeasiMoneda[aceeasiMoneda.length - 1];
          const d = nr(ultima.pret_unitar) - nr(prima.pret_unitar);
          if (!nr(prima.pret_unitar)) return "";
          const pct = (d / nr(prima.pret_unitar)) * 100;
          const semn = d > 0 ? "+" : "";
          const culoare = d > 0 ? "var(--rosu, #b23)" : d < 0 ? "var(--verde, #171)" : "var(--text-muted)";
          return `<span style="color:${culoare}">${semn}${pct.toFixed(1).replace(".", ",")}% față de ${esc(String(prima.data).slice(0, 10))}</span>`;
        })();
        return `
          <h3 style="margin:22px 0 6px">${esc(ultima.denumire)} <span style="font-weight:400;font-size:13px;color:var(--text-muted)">· ${g.length} ${g.length === 1 ? "comandă" : "comenzi"} ${variatie}</span></h3>
          ${table(
            ["Data", "Comandă", "Furnizor", "Preț unitar", "Cantitate"],
            g.slice(0, 10).map((x) => [
              esc(String(x.data).slice(0, 10)),
              `<a href="/procurement/comenzi/${x.comanda_id}">${esc(x.numar || "#" + x.comanda_id)}</a>`,
              esc(x.furnizor),
              `<strong>${esc(nr(x.pret_unitar).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }))} ${esc(x.moneda)}</strong>${x.um ? "/" + esc(x.um) : ""}`,
              esc(nr(x.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })) + (x.um ? " " + esc(x.um) : ""),
            ])
          )}`;
      });

    const body = `
      <div class="toolbar"><a href="/procurement/comenzi" class="btn secondary">← Comenzi</a></div>
      <form class="filtre" method="get" action="/procurement/comenzi/preturi">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="produs sau furnizor" style="min-width:280px">
        <button class="btn small" type="submit">Caută</button>
      </form>
      <p style="font-size:13px;color:var(--text-muted)">
        Prețurile de aici sunt chiar liniile comenzilor trimise, nu o listă ținută separat. Comenzile anulate nu apar.
      </p>
      ${blocuri.length ? blocuri.join("") : "<p>Încă nu există comenzi cu preț.</p>"}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Istoric prețuri de achiziție", active: "/procurement/comenzi", body }));
  });

  // ---- cursul BNR al unei zile, pentru formular --------------------------
  // Stă înainte de /procurement/comenzi/:id, altfel „curs.json" ar fi luat
  // drept numărul unei comenzi.
  router.get("/procurement/comenzi/curs.json", async (ctx) => {
    const data = eData(text((ctx.query || {}).data)) ? text(ctx.query.data) : azi();
    const cursuri = await cursuriBnr(data);
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    ctx.res.end(JSON.stringify({ data, cursuri }));
  });

  // ---- formular de comandă nouă ------------------------------------------
  router.get("/procurement/comenzi/noua", async (ctx) => {
    const eroare = text((ctx.query || {}).eroare);
    const furnizorAles = parseInt((ctx.query || {}).furnizor, 10) || null;
    const furnizori = await db
      .prepare("SELECT id, nume, email FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 3000")
      .all();
    const produse = await db
      .prepare("SELECT id, cod, denumire, unitate_masura, categorie FROM produse WHERE COALESCE(activ,1) = 1 ORDER BY denumire LIMIT 6000")
      .all();
    const preturi = await ultimelePreturi();
    const monede = await monedeDisponibile();
    const bnr = await cursuriBnr(azi());

    const body = `
      ${eroare ? `<div class="flash eroare">${esc(MESAJE_EROARE[eroare] || "Comanda nu s-a putut salva.")}</div>` : ""}

      ${formularComanda({
        mod: "nou",
        actiune: "/procurement/comenzi",
        c: { furnizor_id: furnizorAles, data: azi(), moneda: "RON" },
        linii: [],
        furnizori,
        monede,
      })}

      <!-- Furnizorul nou se adaugă din aceeași pagină, dar cu formularul lui:
           altfel un câmp gol de la furnizor ar bloca salvarea comenzii, sau
           invers. Două formulare nu se pot imbrica în HTML, de-aia ăsta stă
           jos, după comandă, și nu lângă butonul care îl deschide.
           DE-AIA SE ȘI DERULEAZĂ LA EL CÂND SE DESCHIDE: butonul e sus, lângă
           lista de furnizori, iar formularul se deschidea la 1020 px, sub
           marginea de jos a ecranului. Butonul dispărea, pagina stătea pe loc,
           și arăta exact ca un buton stricat. (Raportat de Vali, 28.10.2026.) -->
      <form class="form" id="cf-furnizor-nou" method="post" action="/procurement/furnizor" style="display:none;max-width:980px;margin-top:28px;border-top:1px solid var(--border);padding-top:18px">
        <h2>Furnizor nou</h2>
        <p style="font-size:12px;color:var(--text-muted);margin-top:0">
          Se salvează separat de comandă, deci pagina se reîncarcă și pozițiile scrise sus se pierd.
          Adaugă întâi furnizorul — după salvare te întorci aici cu el deja ales — și abia apoi scrie ce comanzi.
        </p>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">
          <label class="field"><span>Denumire</span><input name="nume" required placeholder="ex. Teraplast SA"></label>
          <label class="field"><span>CUI</span><input name="cui" placeholder="RO12345678"></label>
          <label class="field"><span>Telefon</span><input name="telefon"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px">
          <label class="field"><span>Email firmă</span><input type="email" name="email" placeholder="office@furnizor.ro"></label>
          <label class="field"><span>Adresă</span><input name="adresa"></label>
        </div>
        <h3 style="margin-bottom:4px">Persoane de contact</h3>
        <p style="font-size:12px;color:var(--text-muted);margin-top:0">Câte vrei. Emailurile lor apar bifabile când trimiți comanda.</p>
        ${[0, 1, 2]
          .map(
            () => `<div style="display:grid;grid-template-columns:2fr 1fr 2fr 1fr;gap:10px;margin-bottom:8px">
              <input name="c_nume[]" placeholder="nume">
              <input name="c_functie[]" placeholder="funcție">
              <input type="email" name="c_email[]" placeholder="email">
              <input name="c_telefon[]" placeholder="telefon">
            </div>`
          )
          .join("")}
        <div class="form-actions">
          <button class="btn" type="submit">Adaugă furnizorul</button>
          <button type="button" class="btn secondary" onclick="cfInchideFurnizor()">Închide</button>
        </div>
      </form>

      <script>
      function cfDeschideFurnizor() {
        var panou = document.getElementById("cf-furnizor-nou");
        var buton = document.getElementById("cf-buton-furnizor-nou");
        if (!panou) return;
        panou.style.display = "block";
        if (buton) buton.style.display = "none";
        // Derularea e tot ce lipsea. „block" fără ea deschide formularul sub
        // marginea de jos a ecranului, iar omul vede doar butonul dispărând.
        panou.scrollIntoView({ behavior: "smooth", block: "start" });
        var primul = panou.querySelector("input[name=nume]");
        if (primul) setTimeout(function () { primul.focus(); }, 300);
      }
      function cfInchideFurnizor() {
        var panou = document.getElementById("cf-furnizor-nou");
        var buton = document.getElementById("cf-buton-furnizor-nou");
        if (panou) panou.style.display = "none";
        // Butonul trebuie să se întoarcă. Înainte rămânea ascuns pentru
        // totdeauna: după „Închide" nu se mai putea adăuga niciun furnizor
        // fără reîncărcarea paginii.
        if (buton) {
          buton.style.display = "";
          buton.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
      </script>

      <datalist id="cf-unitati">${UNITATI.map((u) => `<option value="${u}">`).join("")}</datalist>
      ${datalistProduse(produse, preturi)}
      ${scriptCurs(bnr)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă către furnizor", active: "/procurement/comenzi", body }));
  });

  // ---- salvarea comenzii --------------------------------------------------
  router.post("/procurement/comenzi", async (ctx) => {
    const b = ctx.body || {};
    const monede = await monedeDisponibile();
    const f = citesteFormular(b, monede);
    if (f.eroare) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=" + f.eroare);
    const { antet, linii } = f;
    await completeazaCursuri(antet);

    const an = antet.data.slice(0, 4);
    const ultim = await db
      .prepare("SELECT numar FROM comenzi_furnizor WHERE numar LIKE ? ORDER BY numar DESC LIMIT 1")
      .get("CF-" + an + "-%");
    const numar = L.numarUrmator(ultim && ultim.numar, an);

    const ins = await db
      .prepare(
        `INSERT INTO comenzi_furnizor (numar, furnizor_id, data, data_solicitata, status, moneda, curs, curs_eur, observatii, creata_de, creata_la)
         VALUES (?, ?, ?, ?, 'ciorna', ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(
        numar,
        antet.furnizor_id,
        antet.data,
        antet.data_solicitata,
        antet.moneda,
        antet.curs,
        antet.curs_eur,
        antet.observatii,
        ctx.user ? ctx.user.id : null,
        acum()
      );
    const id = ins.lastInsertRowid;

    for (const l of linii) {
      await db
        .prepare(
          `INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, um, pret_unitar)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, l.produs_id, l.denumire, l.cantitate, l.um, l.pret_unitar);
    }

    // Primul rând din istoric: cine a scris-o, când, cu ce.
    const t = L.totalComanda(linii);
    const cursuri = L.cursurile(antet);
    const despre = [
      `${linii.length} ${linii.length === 1 ? "poziție" : "poziții"}`,
      sumaCu(t.total, antet.moneda) + (t.faraPret ? ` (+${t.faraPret} fără preț)` : ""),
    ];
    if (antet.moneda !== "RON" && cursuri.curs) despre.push(`curs ${L.scrieCurs(cursuri.curs)} lei/${antet.moneda}`);
    if (antet.moneda !== "EUR" && cursuri.cursEur) despre.push(`curs EUR ${L.scrieCurs(cursuri.cursEur)}`);
    await scrieIstoric(id, ctx.user, [{ ce: "Comandă creată", vechi: "", nou: despre.join(" · ") }]);

    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });

  // ---- furnizor nou, din aceeași pagină ----------------------------------
  router.post("/procurement/furnizor", async (ctx) => {
    const b = ctx.body || {};
    const nume = text(b.nume);
    if (!nume) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=furnizor");

    // Dacă firma există deja ca client, nu se face un al doilea rând: devine
    // „ambele". Două rânduri pe aceeași firmă înseamnă, peste trei luni,
    // jumătate din facturi pe unul și jumătate pe celălalt.
    const cui = text(b.cui).toUpperCase().replace(/[^0-9A-Z]/g, "");
    let existent = null;
    if (cui) {
      existent = await db
        .prepare("SELECT id, tip FROM parteneri WHERE UPPER(REGEXP_REPLACE(COALESCE(cui,''), '[^0-9A-Za-z]', '', 'g')) = ? LIMIT 1")
        .get(cui)
        .catch(() => null);
    }
    if (!existent) {
      existent = await db.prepare("SELECT id, tip FROM parteneri WHERE LOWER(nume) = LOWER(?) LIMIT 1").get(nume).catch(() => null);
    }

    let id;
    if (existent) {
      id = existent.id;
      const tipNou = existent.tip === "furnizor" || existent.tip === "ambele" ? existent.tip : "ambele";
      await db
        .prepare(
          `UPDATE parteneri SET tip = ?,
                  cui = COALESCE(NULLIF(cui,''), ?), email = COALESCE(NULLIF(email,''), ?),
                  telefon = COALESCE(NULLIF(telefon,''), ?), adresa = COALESCE(NULLIF(adresa,''), ?)
            WHERE id = ?`
        )
        .run(tipNou, text(b.cui) || null, text(b.email) || null, text(b.telefon) || null, text(b.adresa) || null, id);
    } else {
      const r = await db
        .prepare(
          `INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa, sursa, stare)
           VALUES ('furnizor', ?, ?, ?, ?, ?, 'comandă furnizor', 'furnizor') RETURNING id`
        )
        .run(nume, text(b.cui) || null, text(b.email) || null, text(b.telefon) || null, text(b.adresa) || null);
      id = r.lastInsertRowid;
    }

    const nume_ = asArray(b["c_nume[]"]);
    const fct = asArray(b["c_functie[]"]);
    const em = asArray(b["c_email[]"]);
    const tel = asArray(b["c_telefon[]"]);
    for (let i = 0; i < nume_.length; i++) {
      const n = text(nume_[i]);
      const e = text(em[i]);
      if (!n && !e) continue;
      await db
        .prepare(
          `INSERT INTO mk_contacte (partener_id, nume, functie, email, telefon, sursa, creat_de)
           VALUES (?, ?, ?, ?, ?, 'comandă furnizor', ?)`
        )
        .run(id, n || e, text(fct[i]) || null, e || null, text(tel[i]) || null, ctx.user ? ctx.user.id : null);
    }
    redirect(ctx.res, `/procurement/comenzi/noua?furnizor=${id}`);
  });

  // ---- modificarea ulterioară ------------------------------------------
  //
  // Se poate schimba tot ce s-a scris la creare: furnizorul, datele, moneda,
  // cursul, observațiile și pozițiile (adăugate, schimbate, șterse). Fiecare
  // schimbare intră în istoric, cu numele omului și ora.
  //
  // Ce NU se poate:
  //   • o comandă anulată nu se modifică — e scoasă din totaluri și din
  //     istoricul de preț, iar o modificare pe ea n-ar ajunge nicăieri;
  //   • o poziție pe care a intrat deja marfă nu se șterge — i se poate
  //     schimba cantitatea, dar recepția ei trebuie să rămână undeva.
  async function paginaModificare(ctx, c, liniiVechi, o) {
    const opt = o || {};
    const furnizori = await db
      .prepare("SELECT id, nume, email FROM parteneri WHERE tip IN ('furnizor','ambele') OR id = ? ORDER BY nume LIMIT 3000")
      .all(c.furnizor_id || 0);
    const produse = await db
      .prepare("SELECT id, cod, denumire, unitate_masura, categorie FROM produse WHERE COALESCE(activ,1) = 1 ORDER BY denumire LIMIT 6000")
      .all();
    const preturi = await ultimelePreturi();
    const monede = await monedeDisponibile(c.moneda);
    const ef = await cursulEfectiv(c);

    let valori;
    let linii;
    let atins;
    if (opt.valori) {
      // Formularul întors cu eroare: exact ce a scris omul, cu tot cu
      // cantitatea primită pe pozițiile existente (care nu vine din formular).
      const b = opt.valori;
      const dupaId = new Map(liniiVechi.map((l) => [String(l.id), l]));
      const ids = asArray(b["linie_id[]"]);
      const den = asArray(b["denumire[]"]);
      const prod = asArray(b["produs_id[]"]);
      const cant = asArray(b["cantitate[]"]);
      const um = asArray(b["um[]"]);
      const pret = asArray(b["pret_unitar[]"]);
      const bifate = new Set(asArray(b["sterge_id[]"]).map((x) => String(parseInt(x, 10))));
      linii = den.map((d, i) => {
        const v = dupaId.get(String(parseInt(ids[i], 10)));
        return {
          id: v ? v.id : null,
          sters: Boolean(v && bifate.has(String(v.id))),
          produs_id: prod[i] || "",
          denumire: d,
          cantitate: String(cant[i] === undefined ? "" : cant[i]),
          um: um[i] || "",
          pret_unitar: String(pret[i] === undefined ? "" : pret[i]),
          cantitate_primita: v ? v.cantitate_primita : 0,
        };
      });
      valori = {
        id: c.id,
        furnizor_id: b.furnizor_id,
        data: b.data,
        data_solicitata: b.data_solicitata,
        moneda: text(b.moneda).toUpperCase() || c.moneda,
        curs: String(b.curs === undefined ? "" : b.curs),
        curs_eur: String(b.curs_eur === undefined ? "" : b.curs_eur),
        observatii: b.observatii,
      };
      atins = { curs: text(b.curs) !== "", eur: text(b.curs_eur) !== "" };
    } else {
      // Numerele din bază se dau formularului ca numere, ca să fie scrise cu
      // virgulă; doar ce a tastat omul se întoarce ca text, neatins.
      const numar = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
      linii = liniiVechi.map((l) => Object.assign({}, l, { cantitate: numar(l.cantitate), pret_unitar: numar(l.pret_unitar) }));
      // Cursurile scrise pe comandă rămân ale ei. La comenzile vechi, fără
      // curs, se propune BNR-ul zilei lor (și nu se socotește drept „atins").
      valori = Object.assign({}, c, {
        curs: ef.moneda === "RON" || ef.moneda === "EUR" ? null : ef.curs,
        curs_eur: ef.cursEur,
      });
      atins = { curs: nr(c.curs) > 0 && ef.moneda !== "EUR", eur: (ef.moneda === "EUR" ? nr(c.curs) : nr(c.curs_eur)) > 0 };
    }

    const avert = [];
    if (c.trimisa_la) {
      avert.push(
        `Comanda a plecat deja la furnizor (${cand(c.trimisa_la)}, către ${c.trimisa_catre || "furnizor"}). ` +
          "Ce schimbi aici nu ajunge singur la el: după salvare, retrimite-o din pagina comenzii sau trimite-i PDF-ul nou."
      );
    }
    if (liniiVechi.some((l) => nr(l.cantitate_primita) > 0)) {
      avert.push("Pe unele poziții a intrat deja marfă. Acelea nu se pot șterge; dacă le schimbi cantitatea, starea comenzii se recalculează din ce s-a primit.");
    }

    const body = `
      <div class="toolbar"><a href="/procurement/comenzi/${c.id}" class="btn secondary">← Înapoi la comandă</a></div>
      <p style="margin-top:0">${badgeStatus(c.status)} <span style="color:var(--text-muted)">${esc(c.furnizor || "")}${c.furnizor ? " · " : ""}Tot ce schimbi aici se scrie în istoricul comenzii, cu numele tău și ora — și rămâne acolo.</span></p>
      ${opt.eroare ? `<div class="flash flash-rosu">${esc(opt.eroare)}</div>` : ""}
      ${
        avert.length
          ? `<div class="detail-box" style="max-width:940px;border-color:var(--warn);background:#fffaf0">
               <strong>Citește înainte să salvezi</strong>
               <ul style="margin:6px 0 0;padding-left:18px">${avert.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
             </div>`
          : ""
      }
      ${formularComanda({
        mod: "modifica",
        actiune: `/procurement/comenzi/${c.id}/modifica`,
        c: valori,
        linii,
        furnizori,
        monede,
        atins,
        motiv: opt.valori ? opt.valori.motiv : "",
      })}
      <datalist id="cf-unitati">${UNITATI.map((u) => `<option value="${u}">`).join("")}</datalist>
      ${datalistProduse(produse, preturi)}
      ${scriptCurs(ef.bnr)}
    `;
    send(
      ctx.res,
      opt.eroare ? 400 : 200,
      layout({ user: ctx.user, title: "Modifică " + (c.numar || "#" + c.id), active: "/procurement/comenzi", body })
    );
  }

  router.get("/procurement/comenzi/:id/modifica", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await comandaCuFurnizor(id);
    if (!c) return redirect(ctx.res, "/procurement/comenzi");
    if (!poateModifica(ctx.user, c) || c.status === "anulata") return redirect(ctx.res, `/procurement/comenzi/${id}`);
    await paginaModificare(ctx, c, await liniile(id));
  });

  router.post("/procurement/comenzi/:id/modifica", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await comandaCuFurnizor(id);
    if (!c) return redirect(ctx.res, "/procurement/comenzi");
    if (!poateModifica(ctx.user, c) || c.status === "anulata") return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const b = ctx.body || {};
    const liniiVechi = await liniile(id);
    const monede = await monedeDisponibile(c.moneda);
    const f = citesteFormular(b, monede);
    if (f.eroare) {
      const mesaj = MESAJE_EROARE[f.eroare] + (f.linie ? ` (poziția „${f.linie}”)` : "");
      return paginaModificare(ctx, c, liniiVechi, { eroare: mesaj, valori: b });
    }
    const { antet, linii } = f;

    // Un ID de linie care nu e al comenzii ăsteia (formular vechi, pagină
    // deschisă de două ori) nu are voie să atingă linia altei comenzi.
    const dupaId = new Map(liniiVechi.map((l) => [String(l.id), l]));
    for (const l of linii) if (l.id && !dupaId.has(String(l.id))) l.id = null;
    const pastrate = new Set(linii.filter((l) => l.id).map((l) => String(l.id)));
    const deSters = liniiVechi.filter((l) => !pastrate.has(String(l.id)));
    const cuMarfa = deSters.find((l) => nr(l.cantitate_primita) > 0);
    if (cuMarfa) {
      return paginaModificare(ctx, c, liniiVechi, {
        eroare: `Poziția „${cuMarfa.denumire}” are deja marfă intrată (${nr(cuMarfa.cantitate_primita).toLocaleString("ro-RO", { maximumFractionDigits: 3 })} ${cuMarfa.um || ""}). Nu se poate șterge — schimbă-i cantitatea.`,
        valori: b,
      });
    }

    // Câmpul arată prețul cu cel mult patru zecimale. Dacă omul nu l-a
    // schimbat, rămâne prețul exact din bază — formularul nu are voie să
    // rotunjească singur un preț și să scrie în istoric o schimbare pe care
    // n-a făcut-o nimeni.
    for (const l of linii) {
      const v = l.id ? dupaId.get(String(l.id)) : null;
      if (!v) continue;
      if (l.pret_unitar !== null && v.pret_unitar !== null && v.pret_unitar !== undefined && v.pret_unitar !== "" &&
          Math.abs(Math.round(Number(v.pret_unitar) * 1e4) / 1e4 - l.pret_unitar) < 1e-9) l.pret_unitar = Number(v.pret_unitar);
      if (Math.abs(Math.round(Number(v.cantitate) * 1e3) / 1e3 - l.cantitate) < 1e-9) l.cantitate = Number(v.cantitate);
    }

    await completeazaCursuri(antet);
    const furnizor = await db.prepare("SELECT id, nume FROM parteneri WHERE id = ?").get(antet.furnizor_id);
    if (!furnizor) return paginaModificare(ctx, c, liniiVechi, { eroare: MESAJE_EROARE.furnizor, valori: b });

    // Comparația se face cu cursul pe care pagina îl arăta deja: la comenzile
    // vechi, fără curs scris, e BNR-ul zilei lor. Altfel prima modificare a
    // unei comenzi vechi ar scrie în istoric „curs: — → 5,0912", deși cifra
    // de pe ecran n-a schimbat-o nimeni.
    const ef = await cursulEfectiv(c);
    const schimbari = L.diferenteAntet(
      {
        furnizor: c.furnizor,
        data: c.data,
        data_solicitata: c.data_solicitata,
        moneda: c.moneda,
        curs: ef.moneda === "RON" ? null : ef.curs,
        curs_eur: ef.cursEur,
        observatii: c.observatii,
      },
      Object.assign({}, antet, { furnizor: furnizor.nume })
    ).concat(L.diferenteLinii(liniiVechi, linii, antet.moneda));

    if (!schimbari.length) return redirect(ctx.res, `/procurement/comenzi/${id}?ok=nimic`);

    await db
      .prepare(
        `UPDATE comenzi_furnizor SET furnizor_id = ?, data = ?, data_solicitata = ?, moneda = ?, curs = ?, curs_eur = ?,
                observatii = ?, modificata_la = ?, modificata_de = ?
          WHERE id = ?`
      )
      .run(
        antet.furnizor_id,
        antet.data,
        antet.data_solicitata,
        antet.moneda,
        antet.curs,
        antet.curs_eur,
        antet.observatii,
        acum(),
        ctx.user ? ctx.user.id : null,
        id
      );
    for (const l of linii) {
      if (l.id) {
        await db
          .prepare(
            `UPDATE comenzi_furnizor_linii SET produs_id = ?, denumire = ?, cantitate = ?, um = ?, pret_unitar = ?
              WHERE id = ? AND comanda_id = ?`
          )
          .run(l.produs_id, l.denumire, l.cantitate, l.um, l.pret_unitar, l.id, id);
      } else {
        await db
          .prepare(
            `INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, um, pret_unitar)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(id, l.produs_id, l.denumire, l.cantitate, l.um, l.pret_unitar);
      }
    }
    for (const l of deSters) {
      await db
        .prepare("DELETE FROM comenzi_furnizor_linii WHERE id = ? AND comanda_id = ? AND COALESCE(cantitate_primita, 0) = 0")
        .run(l.id, id);
    }

    // Pe o comandă din care a intrat deja marfă, starea se socotește din nou:
    // o cantitate mărită pe o comandă „primită" o face iar „primită parțial".
    const liniiDupa = await liniile(id);
    if (liniiDupa.some((l) => nr(l.cantitate_primita) > 0)) {
      const s = L.statusDupaReceptie(liniiDupa, c.status);
      if (s !== c.status) {
        await db.prepare("UPDATE comenzi_furnizor SET status = ? WHERE id = ?").run(s, id);
        schimbari.push({ ce: "Stare", vechi: L.STATUS_ETICHETA[c.status] || c.status, nou: L.STATUS_ETICHETA[s] || s });
      }
    }
    const n = schimbari.length;
    const motiv = text(b.motiv).slice(0, 200);
    if (motiv) schimbari.push({ ce: "Motivul modificării", vechi: "", nou: motiv });
    await scrieIstoric(id, ctx.user, schimbari);
    redirect(ctx.res, `/procurement/comenzi/${id}?ok=modificat&n=${n}`);
  });

  // ---- PDF-ul comenzii ----------------------------------------------------
  router.get("/procurement/comenzi/:id/pdf", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await comandaCuFurnizor(id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/procurement/comenzi", body: "<p>Comanda asta nu există.</p>" }));
    const linii = await liniile(id);
    const ef = await cursulEfectiv(c);
    // Fără limbă cerută, cea a furnizorului: engleză la cei din afară.
    const ceruta = text((ctx.query || {}).limba);
    const limba = ceruta === "en" || ceruta === "ro" ? ceruta : L.limbaImplicita(c.furnizor_cui);
    const html = PDF.pagina({
      comanda: Object.assign({}, c, { curs: ef.curs, curs_eur: ef.cursEur }),
      linii,
      limba,
      tipar: text((ctx.query || {}).tipar) === "1",
      emitent: { nume: c.creata_nume || (ctx.user && ctx.user.nume) || "", email: EXPEDITOR },
      inapoi: `/procurement/comenzi/${id}`,
      alta: `/procurement/comenzi/${id}/pdf?limba=${limba === "en" ? "ro" : "en"}`,
      generatLa: acum(),
    });
    send(ctx.res, 200, html);
  });

  // ---- o comandă: linii, istoric de preț, email, recepție ----------------
  router.get("/procurement/comenzi/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const q = ctx.query || {};
    const c = await comandaCuFurnizor(id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/procurement/comenzi", body: "<p>Comanda asta nu există.</p>" }));

    const linii = await liniile(id);
    const t = L.totalComanda(linii);
    const contacte = await db
      .prepare("SELECT nume, functie, email FROM mk_contacte WHERE partener_id = ? AND COALESCE(activ,1) = 1 AND COALESCE(email,'') <> '' ORDER BY nume")
      .all(c.furnizor_id || 0)
      .catch(() => []);
    const istoric = await citesteIstoric(id);

    const eDeschisa = L.DESCHISE.includes(c.status);
    const intr = L.intarziere(c.data_solicitata, c.data_receptie);
    const ef = await cursulEfectiv(c);
    const m = ef.moneda;
    const cursObj = { moneda: m, curs: ef.curs, curs_eur: ef.cursEur };
    const ech = L.echivalente(t.total, cursObj);
    const potiModifica = poateModifica(ctx.user, c) && c.status !== "anulata";
    // Limba documentelor pentru furnizor (PDF și email): engleză la cei din
    // afară — CIF cu alt prefix decât RO, ca WBV (DE…). Cealaltă rămâne la un
    // click. Pagina, pentru noi, rămâne în română.
    const limbaFurnizor = L.limbaImplicita(c.furnizor_cui);
    const altaLimba = limbaFurnizor === "en" ? "ro" : "en";
    const limba = text(q.limba) === "en" || text(q.limba) === "ro" ? text(q.limba) : limbaFurnizor;

    // Istoricul de preț, pe fiecare poziție care are produs în nomenclator.
    const istorii = new Map();
    for (const l of linii) {
      if (l.produs_id && !istorii.has(l.produs_id)) istorii.set(l.produs_id, await istoricProdus(l.produs_id, id));
    }

    const coloanaEchiv = m === "RON" ? "În euro" : "În lei";
    const randuriLinii = linii.map((l) => {
      const v = L.valoareLinie(l);
      const ist = l.produs_id ? istorii.get(l.produs_id) || [] : [];
      const anterior = ist.find((x) => x.moneda === c.moneda && x.pret_unitar !== null);
      let fata = "";
      if (anterior && nr(anterior.pret_unitar) > 0 && l.pret_unitar !== null && l.pret_unitar !== undefined) {
        const d = ((nr(l.pret_unitar) - nr(anterior.pret_unitar)) / nr(anterior.pret_unitar)) * 100;
        const culoare = d > 0.05 ? "var(--rosu, #b23)" : d < -0.05 ? "var(--verde, #171)" : "var(--text-muted)";
        fata = `<span style="font-size:12px;color:${culoare}">${d > 0 ? "+" : ""}${d.toFixed(1).replace(".", ",")}% față de ${esc(String(anterior.data).slice(0, 10))} (${esc(anterior.furnizor)})</span>`;
      } else if (l.produs_id) {
        fata = `<span style="font-size:12px;color:var(--text-muted)">prima comandă prin ERP</span>`;
      }
      const primit = nr(l.cantitate_primita);
      const e = v === null ? { ron: null, eur: null } : L.echivalente(v, cursObj);
      const echivLinie = m === "RON" ? e.eur : e.ron;
      return [
        `${esc(l.denumire)}${l.produs_cod ? `<br><span style="font-size:12px;color:var(--text-muted)">cod ${esc(l.produs_cod)}</span>` : ""}`,
        esc(nr(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })) + (l.um ? " " + esc(l.um) : ""),
        l.pret_unitar === null || l.pret_unitar === undefined
          ? '<span style="color:var(--text-muted)">de confirmat</span>'
          : `${esc(nr(l.pret_unitar).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }))} ${esc(m)}`,
        v === null ? '<span style="color:var(--text-muted)">—</span>' : `<strong>${esc(sumaCu(v, m))}</strong>`,
        echivLinie === null ? '<span style="color:var(--text-muted)">—</span>' : esc(sumaCu(echivLinie, m === "RON" ? "EUR" : "lei")),
        primit > 0
          ? `${esc(primit.toLocaleString("ro-RO", { maximumFractionDigits: 3 }))}${primit + 0.0001 < nr(l.cantitate) ? ' <span class="badge galben">parțial</span>' : ' <span class="badge verde">complet</span>'}`
          : '<span style="color:var(--text-muted)">—</span>',
        fata,
      ];
    });

    // De unde e cursul, spus pe față: pus pe comandă (și cât diferă de BNR)
    // sau luat de la BNR pentru că pe comandă nu e niciunul.
    const descrieCurs = (valoare, moneda, dinBnr) => {
      if (!valoare) return `<div class="label">lipsește — pune-l din „Modifică”</div>`;
      const b = ef.bnr[moneda];
      if (dinBnr) return `<div class="label">BNR din ${esc(cand(b ? b.data : ""))}, nescris pe comandă</div>`;
      if (!b) return `<div class="label">pus pe comandă</div>`;
      const ab = L.abatereFataDeBnr(valoare, b.valoare);
      if (ab === 0) return `<div class="label">pus pe comandă · = BNR din ${esc(cand(b.data))}</div>`;
      return `<div class="label">pus pe comandă · BNR ${esc(cand(b.data))}: ${esc(L.scrieCurs(b.valoare))} (${ab > 0 ? "+" : ""}${esc(String(ab).replace(".", ","))}%)</div>`;
    };
    const carduriCurs = [];
    if (m !== "RON") {
      carduriCurs.push(
        `<div class="card"><div class="label">În lei</div><div class="value">${ech.ron === null ? "—" : esc(sumaCu(ech.ron, "lei"))}</div></div>`
      );
    }
    if (m !== "EUR") {
      carduriCurs.push(
        `<div class="card"><div class="label">În euro</div><div class="value">${ech.eur === null ? "—" : esc(sumaCu(ech.eur, "EUR"))}</div></div>`
      );
    }
    if (m !== "RON") {
      carduriCurs.push(
        `<div class="card"><div class="label">Curs ${esc(m)}</div><div class="value">${ef.curs ? esc(L.scrieCurs(ef.curs)) + " lei" : "—"}</div>${descrieCurs(ef.curs, m, ef.dinBnr)}</div>`
      );
    }
    if (m !== "EUR") {
      carduriCurs.push(
        `<div class="card"><div class="label">Curs EUR</div><div class="value">${ef.cursEur ? esc(L.scrieCurs(ef.cursEur)) + " lei" : "—"}</div>${descrieCurs(ef.cursEur, "EUR", ef.eurDinBnr)}</div>`
      );
    }

    const corp = L.corpEmail({
      comanda: c,
      linii,
      furnizor: c.furnizor,
      limba,
      semnatura:
        limba === "en"
          ? `Best regards,\n${ctx.user ? ctx.user.nume : ""}\nCash Machine SRL\n${EXPEDITOR}`
          : `Cu stimă,\n${ctx.user ? ctx.user.nume : ""}\nCash Machine SRL\n${EXPEDITOR}`,
    });

    const destinatari = [];
    if (text(c.furnizor_email)) destinatari.push({ eticheta: c.furnizor + " (firmă)", email: text(c.furnizor_email) });
    for (const p of contacte) destinatari.push({ eticheta: p.nume + (p.functie ? ", " + p.functie : ""), email: text(p.email) });

    // Comanda schimbată după ce a plecat: furnizorul are încă varianta veche.
    const modificataDupaTrimitere = c.trimisa_la && c.modificata_la && String(c.modificata_la) > String(c.trimisa_la);

    // Rândurile istoricului. Comenzile de dinainte de 05.11.2026 n-au rândul
    // „Comandă creată" — se arată din ce știe comanda despre ea (ziua, fără
    // oră: ora de atunci s-a scris în ora serverului, nu în a noastră).
    const randuriIstoric = istoric.map((h) => [
      esc(cand(h.la)),
      esc(h.utilizator_nume || "—"),
      esc(h.ce),
      h.vechi ? esc(h.vechi) : '<span style="color:var(--text-muted)">—</span>',
      h.nou ? esc(h.nou) : '<span style="color:var(--text-muted)">—</span>',
    ]);
    if (!istoric.some((h) => h.ce === "Comandă creată")) {
      randuriIstoric.push([
        esc(cand(String(c.creata_la || c.data || "").slice(0, 10))),
        esc(c.creata_nume || "—"),
        "Comandă creată",
        '<span style="color:var(--text-muted)">—</span>',
        '<span style="color:var(--text-muted)">înainte de istoric</span>',
      ]);
    }

    const MESAJE = {
      modificat: `Salvat. ${Number(q.n) || 0} ${Number(q.n) === 1 ? "schimbare scrisă" : "schimbări scrise"} în istoricul comenzii.`,
      nimic: "N-a fost nimic de schimbat — comanda a rămas cum era.",
    };
    const flash = MESAJE[text(q.ok)] || null;
    const eroareTrimitere = text(q.eroare);

    const body = `
      <div class="toolbar" style="flex-wrap:wrap">
        <a href="/procurement/comenzi" class="btn secondary">← Toate comenzile</a>
        ${potiModifica ? `<a href="/procurement/comenzi/${c.id}/modifica" class="btn">Modifică comanda</a>` : ""}
        <a href="/procurement/comenzi/${c.id}/pdf?limba=${limbaFurnizor}&amp;tipar=1" target="_blank" rel="noopener" class="btn secondary" title="Se deschide comanda gata de tipărit; alege „Salvează ca PDF”">Export PDF${limbaFurnizor === "en" ? " (engleză)" : ""}</a>
        <a href="/procurement/comenzi/${c.id}/pdf?limba=${altaLimba}&amp;tipar=1" target="_blank" rel="noopener" class="btn secondary">PDF în ${altaLimba === "en" ? "engleză" : "română"}</a>
        ${c.furnizor_id ? `<a href="/parteneri/${c.furnizor_id}" class="btn secondary">Fișa furnizorului</a>` : ""}
        <a href="/procurement/comenzi/preturi?q=${encodeURIComponent(linii[0] ? linii[0].denumire : "")}" class="btn secondary">Istoric prețuri</a>
      </div>

      ${
        eroareTrimitere
          ? `<div class="flash flash-rosu">${esc(eroareTrimitere === "destinatar" ? "Emailul n-a plecat: alege cel puțin un destinatar." : "Emailul n-a plecat: " + eroareTrimitere)}</div>`
          : ""
      }

      <h1 style="margin-bottom:4px">${esc(c.numar || "#" + c.id)} ${badgeStatus(c.status)}</h1>
      <p style="color:var(--text-muted);margin-top:0">
        ${esc(c.furnizor || "fără furnizor")} · emisă ${esc(String(c.data || "").slice(0, 10))}${c.creata_nume ? " de " + esc(c.creata_nume) : ""}
        ${c.trimisa_la ? ` · trimisă ${esc(cand(c.trimisa_la))} către ${esc(c.trimisa_catre || "")}` : ""}
        ${c.modificata_la ? ` · modificată ${esc(cand(c.modificata_la))}${c.modificata_nume ? " de " + esc(c.modificata_nume) : ""}` : ""}
      </p>

      ${
        modificataDupaTrimitere && eDeschisa
          ? `<div class="detail-box" style="max-width:940px;border-color:var(--warn);background:#fffaf0">
               <strong>Comanda a fost modificată după ce a plecat la furnizor.</strong>
               Furnizorul are încă varianta din ${esc(cand(c.trimisa_la))}. Retrimite-o de mai jos sau trimite-i PDF-ul nou.
             </div>`
          : ""
      }

      <div class="cards">
        <div class="card"><div class="label">Valoare</div><div class="value">${esc(sumaCu(t.total, m))}</div>${t.faraPret ? `<div class="label">${t.faraPret} fără preț</div>` : ""}</div>
        ${carduriCurs.join("")}
        <div class="card"><div class="label">Data solicitată</div><div class="value">${esc(String(c.data_solicitata || "—").slice(0, 10))}</div></div>
        <div class="card"><div class="label">Data recepției</div><div class="value">${esc(String(c.data_receptie || "—").slice(0, 10))}</div>${
          intr === null ? "" : `<div class="label">${intr > 0 ? "cu " + intr + " zile întârziere" : intr === 0 ? "la timp" : "cu " + -intr + " zile mai devreme"}</div>`
        }</div>
      </div>

      <div class="tabel-scroll">
      ${table(["Poziție", "Cantitate", "Preț unitar", "Valoare", coloanaEchiv, "Primit", "Față de ultima"], randuriLinii)}
      </div>
      ${c.observatii ? `<p><strong>Observații:</strong> ${esc(c.observatii)}</p>` : ""}
      <p style="font-size:12px;color:var(--text-muted)">Pe PDF și în email se pune singur și ${esc(L.orarDescarcare("ro").replace(/^O/, "o"))}.</p>

      ${
        eDeschisa && poateTrimite(ctx.user)
          ? `
      <h2 style="margin-top:28px" id="trimite">Trimite comanda</h2>
      <p style="font-size:13px;margin-top:-6px">
        Mesajul în: ${limba === "en" ? `<a href="/procurement/comenzi/${c.id}?limba=ro#trimite">română</a> · <strong>engleză</strong>` : `<strong>română</strong> · <a href="/procurement/comenzi/${c.id}?limba=en#trimite">engleză</a>`}${
          limbaFurnizor === "en" ? ' <span style="color:var(--text-muted)">(furnizor din afară — pornește în engleză)</span>' : ""
        }
      </p>
      ${
        destinatari.length
          ? `<form class="form" method="post" action="/procurement/comenzi/${c.id}/trimite" style="max-width:860px"
                   onsubmit="return confirm('Emailul pleacă acum către furnizor. Trimit?')">
          <div class="field"><span>Către</span>
            ${destinatari
              .map(
                (d, i) =>
                  `<label style="display:block;font-weight:400"><input type="checkbox" name="catre[]" value="${esc(d.email)}"${i === 0 ? " checked" : ""}> ${esc(d.eticheta)} — ${esc(d.email)}</label>`
              )
              .join("")}
          </div>
          <label class="field"><span>…și/sau alte adrese, despărțite cu virgulă</span><input name="catre_text" placeholder="nume@furnizor.ro"></label>
          <label class="field"><span>De pe adresa</span><input name="de_la" value="${esc(EXPEDITOR)}"></label>
          <label class="field"><span>Subiect</span><input name="subiect" value="${esc(limba === "en" ? `Purchase order ${c.numar || ""} — Cash Machine SRL` : `Comandă ${c.numar || ""} — Cash Machine SRL`)}" required></label>
          <label class="field"><span>Mesaj</span><textarea name="corp" rows="16" style="font-family:monospace;font-size:13px">${esc(corp)}</textarea></label>
          <div class="form-actions"><button class="btn" type="submit">Trimite comanda pe email</button></div>
        </form>`
          : `<p>Furnizorul n-are nicio adresă de email, nici pe fișă nici pe persoanele de contact.
               <a href="/parteneri/${c.furnizor_id || ""}">Completeaz-o pe fișa lui</a> și revino.</p>`
      }`
          : ""
      }

      ${
        eDeschisa && poateTrimite(ctx.user)
          ? `
      <h2 style="margin-top:28px">Recepție</h2>
      <form class="form" method="post" action="/procurement/comenzi/${c.id}/receptie" style="max-width:860px">
        <p style="font-size:13px;color:var(--text-muted);margin-top:0">
          Scrie cât a intrat efectiv din fiecare poziție. Starea comenzii se calculează din cantități:
          „primită" doar când e acoperită fiecare linie.
        </p>
        <table class="tabel">
          <thead><tr><th>Poziție</th><th>Comandat</th><th>Primit până acum</th><th>Primit acum (total)</th></tr></thead>
          <tbody>
            ${linii
              .map(
                (l) => `<tr>
                  <td>${esc(l.denumire)}</td>
                  <td>${esc(nr(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 }))} ${esc(l.um || "")}</td>
                  <td>${esc(nr(l.cantitate_primita).toLocaleString("ro-RO", { maximumFractionDigits: 3 }))}</td>
                  <td>
                    <input type="hidden" name="linie_id[]" value="${l.id}">
                    <input type="number" step="0.001" name="primit[]" value="${esc(nr(l.cantitate_primita) || "")}" style="width:120px" placeholder="${esc(String(nr(l.cantitate)))}">
                  </td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-top:10px">
          <label class="field"><span>Data recepției</span><input type="date" name="data_receptie" value="${esc(String(c.data_receptie || azi()).slice(0, 10))}"></label>
          <label class="field"><span>&nbsp;</span>
            <label style="font-weight:400"><input type="checkbox" name="tot" value="1"> a intrat tot ce era comandat</label>
          </label>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Înregistrează recepția</button>
        </div>
      </form>

      <form method="post" action="/procurement/comenzi/${c.id}/anuleaza" style="margin-top:18px"
            onsubmit="return confirm('Comanda se marchează anulată. Rămâne în istoric, dar iese din totaluri. Continui?')">
        <button class="btn secondary" type="submit">Anulează comanda</button>
      </form>`
          : ""
      }

      <h2 style="margin-top:32px">Istoric — cine a modificat ce și când</h2>
      <p style="margin:-6px 0 8px;color:var(--text-muted);font-size:13px">
        Cea mai nouă schimbare sus. Rândurile de aici nu se șterg și nu se corectează — asta e tot rostul lor.
      </p>
      <div class="tabel-scroll">
      ${table(["Când", "Cine", "Ce", "Era", "A rămas"], randuriIstoric)}
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă " + (c.numar || "#" + c.id), active: "/procurement/comenzi", body, flash }));
  });

  // ---- trimiterea pe email ------------------------------------------------
  router.post("/procurement/comenzi/:id/trimite", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const b = ctx.body || {};
    const catre = asArray(b["catre[]"])
      .concat(text(b.catre_text).split(/[,;]/))
      .map((x) => text(x))
      .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (!catre.length) return redirect(ctx.res, `/procurement/comenzi/${id}?eroare=destinatar`);

    const c = await db.prepare("SELECT * FROM comenzi_furnizor WHERE id = ?").get(id);
    if (!c) return redirect(ctx.res, "/procurement/comenzi");

    let eroare = null;
    try {
      await mail.trimiteDeLa(ctx.user, {
        catre,
        subiect: text(b.subiect) || `Comandă ${c.numar || ""} — Cash Machine SRL`,
        corp: String(b.corp || ""),
        deLa: text(b.de_la) || EXPEDITOR,
      });
    } catch (e) {
      eroare = e.message;
    }

    if (!eroare) {
      await db
        .prepare(
          `UPDATE comenzi_furnizor SET status = CASE WHEN status = 'ciorna' THEN 'trimisa' ELSE status END,
                  trimisa_la = ?, trimisa_catre = ? WHERE id = ?`
        )
        .run(acum(), catre.join(", ").slice(0, 400), id);
      const schimbari = [{ ce: "Trimisă pe email", vechi: "", nou: `către ${catre.join(", ")}` }];
      if (c.status === "ciorna") schimbari.push({ ce: "Stare", vechi: L.STATUS_ETICHETA.ciorna, nou: L.STATUS_ETICHETA.trimisa });
      await scrieIstoric(id, ctx.user, schimbari);
      // Urma rămâne și pe fișa furnizorului: peste șase luni, când cineva
      // întreabă „i-am mai comandat?", răspunsul trebuie să fie pe fișă, nu
      // în memoria cuiva.
      if (c.furnizor_id) {
        await db
          .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'email', ?, ?, ?)")
          .run(c.furnizor_id, `Comandă ${c.numar || "#" + id} trimisă`, `Către ${catre.join(", ")}`, ctx.user ? ctx.user.id : null)
          .catch(() => {});
      }
    }
    redirect(ctx.res, `/procurement/comenzi/${id}${eroare ? "?eroare=" + encodeURIComponent(eroare.slice(0, 160)) : ""}`);
  });

  // ---- recepția -----------------------------------------------------------
  router.post("/procurement/comenzi/:id/receptie", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const b = ctx.body || {};
    const ids = asArray(b["linie_id[]"]);
    const primite = asArray(b["primit[]"]);
    const tot = text(b.tot) === "1";
    const inainte = await db.prepare("SELECT status, data_receptie FROM comenzi_furnizor WHERE id = ?").get(id);
    if (!inainte) return redirect(ctx.res, "/procurement/comenzi");

    const linii = await liniile(id);
    const dupaId = new Map(linii.map((l) => [String(l.id), l]));
    const schimbari = [];

    for (let i = 0; i < ids.length; i++) {
      const l = dupaId.get(String(ids[i]));
      if (!l) continue;
      let v;
      if (tot) v = nr(l.cantitate);
      else {
        const s = text(primite[i]).replace(",", ".");
        // Gol înseamnă „nu schimb nimic", nu „zero". Altfel o recepție
        // parțială în care completezi o singură linie ar șterge tăcut ce era
        // deja înregistrat pe celelalte.
        if (s === "") continue;
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0) continue;
        v = n;
      }
      await db.prepare("UPDATE comenzi_furnizor_linii SET cantitate_primita = ? WHERE id = ?").run(v, l.id);
      if (!L.acelasiNumar(nr(l.cantitate_primita), v)) {
        const um = l.um ? " " + l.um : "";
        schimbari.push({
          ce: "Primit · " + l.denumire,
          vechi: nr(l.cantitate_primita).toLocaleString("ro-RO", { maximumFractionDigits: 3 }) + um,
          nou: v.toLocaleString("ro-RO", { maximumFractionDigits: 3 }) + um,
        });
      }
      l.cantitate_primita = v;
    }

    const status = L.statusDupaReceptie(linii, "trimisa");
    const dataRec = text(b.data_receptie).slice(0, 10) || azi();
    await db
      .prepare("UPDATE comenzi_furnizor SET status = ?, data_receptie = CASE WHEN ? = 'primita' OR ? = 'partial' THEN ? ELSE data_receptie END WHERE id = ?")
      .run(status, status, status, dataRec, id);
    if (status !== inainte.status) schimbari.push({ ce: "Stare", vechi: L.STATUS_ETICHETA[inainte.status] || inainte.status, nou: L.STATUS_ETICHETA[status] || status });
    if ((status === "primita" || status === "partial") && String(inainte.data_receptie || "").slice(0, 10) !== dataRec) {
      schimbari.push({ ce: "Data recepției", vechi: String(inainte.data_receptie || "").slice(0, 10), nou: dataRec });
    }
    await scrieIstoric(id, ctx.user, schimbari);
    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });

  // Anularea nu șterge: comanda rămâne în istoric, dar iese din totaluri și
  // din istoricul de preț. O comandă ștearsă ar lăsa o gaură în numerotare pe
  // care nimeni n-ar mai ști s-o explice.
  router.post("/procurement/comenzi/:id/anuleaza", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const inainte = await db.prepare("SELECT status FROM comenzi_furnizor WHERE id = ?").get(id);
    if (!inainte) return redirect(ctx.res, "/procurement/comenzi");
    if (inainte.status !== "anulata") {
      await db.prepare("UPDATE comenzi_furnizor SET status = 'anulata' WHERE id = ?").run(id);
      await scrieIstoric(id, ctx.user, [{ ce: "Stare", vechi: L.STATUS_ETICHETA[inainte.status] || inainte.status, nou: L.STATUS_ETICHETA.anulata }]);
    }
    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });
}

module.exports = { register, EXPEDITOR, MONEDE, UNITATI, poateModifica, citesteFormular };
