"use strict";
// Filtre ca în Excel, pe capul de tabel.
//
// CE A CERUT VALI, 06.11.2026, cu poza listei de comenzi: „Filtre te rog pe
// datele din capul de tabel."
//
// Fiecare coloană primește un ▾ lângă nume. Din el se deschide lista valorilor
// din coloană, cu bifă și cu câte rânduri are fiecare, plus o căsuță de
// căutare. Ca în Excel:
//   • bifele se aplică pe loc; filtrele de pe mai multe coloane se adună;
//   • lista unei coloane arată doar ce trece de filtrele celorlalte — dacă ai
//     ales un client, la Status vezi doar statusurile comenzilor lui;
//   • în căutare, Enter păstrează doar ce se potrivește („11.2026" + Enter =
//     toată luna noiembrie);
//   • la date contează ziua, nu ora; „06.11.2026 06:58" și „06.11.2026 15:39"
//     sunt aceeași bifă.
// Deasupra tabelului scrie câte rânduri se văd și, unde există o coloană
// „Total", suma lor, plus „Șterge filtrele".
//
// Filtrul se ține minte în fereastra omului (sessionStorage), pe cheia
// tabelului: intri într-o comandă, te întorci, filtrul e tot acolo. Închizi
// fereastra, a dispărut — e o căutare de moment, nu o setare.
//
// Se ține ca listă de ce se vede SAU de ce se ascunde, care e mai scurtă.
// „Toate în afară de livrate" e ținut ca „ascunde livratele", deci o comandă
// cu un status nou, apărut mâine, se vede — nu dispare pe tăcute.
//
// Totul se face în browser, pe rândurile deja trimise de server: filtrarea nu
// mai cere nimic serverului și merge pe loc și la câteva sute de comenzi.
// Perioada (azi, luna curentă…) rămâne filtrul de pe server, deasupra.
//
// Scriptul e o funcție adevărată, trimisă cu toString(), nu un text: așa se
// poate citi, iar expresiile regulate nu trebuie scăpate de două ori.

function filtreTabel() {
  var STOC = "filtre-tabel:";
  function citeste(cheie) {
    try { return JSON.parse(sessionStorage.getItem(STOC + cheie) || "{}") || {}; } catch (e) { return {}; }
  }
  function scrie(cheie, v) {
    try { sessionStorage.setItem(STOC + cheie, JSON.stringify(v)); } catch (e) { /* fereastră privată */ }
  }
  function fara(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  // Valoarea unei celule: primul ei rând de text. „06.11.2026" din
  // „06.11.2026 · cea mai târzie din 2 comenzi de producție", numele din
  // badge, textul ales dintr-o listă derulantă. Se citește din copie, nu din
  // celula de pe ecran: o coloană ascunsă din „Coloane" n-are text pe ecran.
  //
  // CE S-A STRICAT (Vali, 11.11.2026, în Stoc la zi): „la Categorie nomenclator
  // și categorie simplă sunt aceleași filtre pe toate, chiar dacă afișează
  // lucruri diferite în fiecare rând". Celula „Categorie nomenclator" are, sub
  // text, panoul pliat „modifică", iar în el lista derulantă a categoriei
  // SIMPLE. Regula „textul ales dintr-o listă derulantă" o lua pe aceea, deci
  // filtrul nomenclatorului arăta produse finite / materie primă, ca vecinul.
  // De-aia: (1) celula își poate spune valoarea pe față, cu data-filtru pe ea
  // sau pe un element din ea — table() nu pune atribute pe <td>; (2) lista
  // derulantă e valoarea celulei doar când e ce se vede în ea, nu când stă
  // într-un panou pliat (<details>); (3) panoul pliat nu intră nici în textul
  // celulei — altfel „Plicuri" cu „modifică" sub el se citea „Plicurimodifică".
  // O celulă care are DOAR un panou pliat rămâne cu titlul lui.
  function valoare(td) {
    if (!td) return "";
    var spus = td.hasAttribute("data-filtru") ? td : td.querySelector("[data-filtru]");
    if (spus) return String(spus.getAttribute("data-filtru")).trim();
    var sel = Array.prototype.filter.call(td.querySelectorAll("select"), function (s) { return !s.closest("details"); })[0];
    if (sel) return String((sel.options[sel.selectedIndex] || {}).text || "").trim();
    var c = td.cloneNode(true);
    c.querySelectorAll("button, form, .filtru-btn").forEach(function (x) { x.remove(); });
    var pliate = Array.prototype.slice.call(c.querySelectorAll("details"));
    var titluPliat = pliate.length ? String((pliate[0].querySelector("summary") || {}).textContent || "").replace(/\s+/g, " ").trim() : "";
    pliate.forEach(function (x) { x.remove(); });
    c.querySelectorAll("br").forEach(function (b) { b.replaceWith("\n"); });
    c.querySelectorAll("div, p, li").forEach(function (b) { b.insertBefore(document.createTextNode("\n"), b.firstChild); });
    var linii = String(c.textContent || "").split("\n").map(function (s) { return s.replace(/\s+/g, " ").trim(); }).filter(Boolean);
    var t = linii[0] || titluPliat || "";
    var d = t.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
    if (d) return d[1] + "." + d[2] + "." + d[3];
    var iso = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);
    if (iso) return iso[3] + "." + iso[2] + "." + iso[1];
    return t;
  }

  // Număr românesc: „1.234,56 lei" → 1234.56. Ce nu e număr dă null.
  function numar(t) {
    var s = String(t || "").replace(/lei|ron|eur|usd|€|%/gi, "").replace(/\s/g, "");
    if (!/^-?[\d.]*(,\d+)?$/.test(s) || !/\d/.test(s)) return null;
    var n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  }

  // Ordinea din listă: datele de la cea mai nouă, numerele crescător, textul
  // alfabetic. Rândurile goale la sfârșit.
  function cheie(v) {
    if (v === "" || v === "—") return [3, 0, ""];
    var d = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (d) return [0, -Date.parse(d[3] + "-" + d[2] + "-" + d[1]), ""];
    var n = numar(v);
    if (n !== null) return [1, n, ""];
    return [2, 0, fara(v)];
  }
  function compara(a, b) {
    var x = cheie(a), y = cheie(b);
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    return x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0;
  }

  function trece(f, v) {
    if (!f) return true;
    if (f.in) return f.in.indexOf(v) !== -1;
    if (f.out) return f.out.indexOf(v) === -1;
    return true;
  }

  function porneste(tabel) {
    var cheieTabel = tabel.getAttribute("data-filtre");
    var bara = document.querySelector('[data-filtre-pentru="' + cheieTabel + '"]');
    var capete = Array.prototype.slice.call(tabel.querySelectorAll("thead tr:last-child th"));
    var nume = capete.map(function (th) { return String(th.textContent || "").replace(/\s+/g, " ").trim(); });
    var corp = tabel.tBodies[0];
    if (!corp) return;
    var randuri = Array.prototype.filter.call(corp.rows, function (r) { return !r.querySelector("td.empty"); });
    randuri.forEach(function (r) { r._valori = Array.prototype.map.call(r.cells, valoare); });
    var idxTotal = nume.findIndex(function (n) { return /^total\b/i.test(n); });
    var stare = citeste(cheieTabel);
    var golRand = null;

    function treceTot(r, inafara) {
      return Object.keys(stare).every(function (k) {
        return String(k) === String(inafara) || trece(stare[k], r._valori[k]);
      });
    }

    function aplica() {
      var vazute = 0;
      var total = 0;
      randuri.forEach(function (r) {
        var ok = treceTot(r, null);
        r.style.display = ok ? "" : "none";
        if (ok) {
          vazute++;
          if (idxTotal >= 0) total += numar(r._valori[idxTotal]) || 0;
        }
      });
      capete.forEach(function (th, i) {
        var b = th.querySelector(".filtru-btn");
        if (b) b.classList.toggle("activ", Boolean(stare[i]));
      });
      var activ = Object.keys(stare).length > 0;
      if (golRand) { golRand.remove(); golRand = null; }
      if (activ && !vazute && randuri.length) {
        golRand = document.createElement("tr");
        golRand.className = "filtre-gol";
        var td = document.createElement("td");
        td.colSpan = capete.length || 1;
        td.className = "empty";
        td.textContent = "Niciun rând nu se potrivește filtrelor.";
        golRand.appendChild(td);
        corp.appendChild(golRand);
      }
      if (bara) {
        var n = bara.querySelector("[data-numar]");
        var t = bara.querySelector("[data-total]");
        var s = bara.querySelector("[data-sterge]");
        if (n) n.textContent = activ ? "Se văd " + vazute + " din " + randuri.length : randuri.length + (randuri.length === 1 ? " rând" : " rânduri");
        if (t) t.textContent = idxTotal >= 0 ? (activ ? "Total afișat: " : "Total: ") + total.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei" : "";
        if (s) s.hidden = !activ;
      }
    }

    var deschis = null;
    function inchide() {
      if (!deschis) return;
      deschis.remove();
      deschis = null;
      document.removeEventListener("mousedown", afara, true);
      document.removeEventListener("keydown", tasta, true);
    }
    function afara(ev) {
      if (deschis && !deschis.contains(ev.target) && !(ev.target.classList && ev.target.classList.contains("filtru-btn"))) inchide();
    }
    function tasta(ev) {
      if (ev.key === "Escape") inchide();
    }

    function deschide(i, buton) {
      if (deschis && deschis._col === i) { inchide(); return; }
      inchide();
      // Valorile coloanei din rândurile care trec de CELELALTE filtre.
      var cate = {};
      randuri.forEach(function (r) {
        if (!treceTot(r, i)) return;
        var v = r._valori[i];
        cate[v] = (cate[v] || 0) + 1;
      });
      var f = stare[i];
      // Valorile ascunse acum rămân în listă, chiar dacă alt filtru le-a
      // golit: altfel n-ai mai avea de unde să le bifezi la loc.
      if (f && f.in) f.in.forEach(function (v) { if (!(v in cate)) cate[v] = 0; });
      if (f && f.out) f.out.forEach(function (v) { if (!(v in cate)) cate[v] = 0; });
      var valori = Object.keys(cate).sort(compara);
      var bifate = valori.filter(function (v) { return trece(f, v); });

      var p = document.createElement("div");
      p.className = "filtru-pop";
      p._col = i;
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-label", "Filtru: " + nume[i]);
      p.innerHTML =
        '<input type="search" class="filtru-cauta" placeholder="Caută…" title="Enter păstrează doar ce se potrivește" autocomplete="off">' +
        '<label class="filtru-tot"><input type="checkbox"> <strong>Selectează tot</strong></label>' +
        '<div class="filtru-lista"></div>' +
        '<div class="filtru-jos"><button type="button" class="filtru-goleste">Șterge filtrul</button><button type="button" class="filtru-ok">Gata</button></div>';
      document.body.appendChild(p);
      var r = buton.getBoundingClientRect();
      var lat = p.offsetWidth || 290;
      var stanga = Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - lat - 8);
      p.style.left = Math.max(window.scrollX + 8, stanga) + "px";
      p.style.top = window.scrollY + r.bottom + 4 + "px";

      var lista = p.querySelector(".filtru-lista");
      var cauta = p.querySelector(".filtru-cauta");
      var tot = p.querySelector(".filtru-tot input");
      var vizibile = [];

      function salveaza() {
        var ascunse = valori.filter(function (v) { return bifate.indexOf(v) === -1; });
        if (!ascunse.length) delete stare[i];
        else if (ascunse.length < bifate.length) stare[i] = { out: ascunse };
        else stare[i] = { in: bifate.slice() };
        scrie(cheieTabel, stare);
        aplica();
      }
      function deseneaza() {
        var q = fara(cauta.value.trim());
        vizibile = valori.filter(function (v) { return !q || fara(v).indexOf(q) !== -1; });
        lista.innerHTML = "";
        vizibile.forEach(function (v) {
          var l = document.createElement("label");
          var c = document.createElement("input");
          c.type = "checkbox";
          c.checked = bifate.indexOf(v) !== -1;
          c.addEventListener("change", function () {
            var k = bifate.indexOf(v);
            if (c.checked && k === -1) bifate.push(v);
            if (!c.checked && k !== -1) bifate.splice(k, 1);
            salveaza();
            deseneazaTot();
          });
          var t = document.createElement("span");
          t.className = "filtru-v";
          t.textContent = v === "" ? "(gol)" : v;
          var n = document.createElement("span");
          n.className = "filtru-n";
          n.textContent = String(cate[v]);
          l.appendChild(c);
          l.appendChild(t);
          l.appendChild(n);
          lista.appendChild(l);
        });
        if (!vizibile.length) {
          var g = document.createElement("div");
          g.className = "filtru-nimic";
          g.textContent = "Nimic nu se potrivește.";
          lista.appendChild(g);
        }
        deseneazaTot();
      }
      function deseneazaTot() {
        var toate = vizibile.length > 0 && vizibile.every(function (v) { return bifate.indexOf(v) !== -1; });
        tot.checked = toate;
        tot.indeterminate = !toate && vizibile.some(function (v) { return bifate.indexOf(v) !== -1; });
      }
      tot.addEventListener("change", function () {
        vizibile.forEach(function (v) {
          var k = bifate.indexOf(v);
          if (tot.checked && k === -1) bifate.push(v);
          if (!tot.checked && k !== -1) bifate.splice(k, 1);
        });
        salveaza();
        deseneaza();
      });
      cauta.addEventListener("input", deseneaza);
      cauta.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        if (cauta.value.trim()) {
          bifate = vizibile.slice();
          salveaza();
        }
        inchide();
      });
      p.querySelector(".filtru-goleste").addEventListener("click", function () {
        bifate = valori.slice();
        salveaza();
        inchide();
      });
      p.querySelector(".filtru-ok").addEventListener("click", inchide);
      deseneaza();
      deschis = p;
      setTimeout(function () {
        document.addEventListener("mousedown", afara, true);
        document.addEventListener("keydown", tasta, true);
      }, 0);
      cauta.focus();
    }

    capete.forEach(function (th, i) {
      if (!nume[i] || /^acțiuni$/i.test(nume[i]) || th.hasAttribute("data-fara-filtru")) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "filtru-btn";
      b.textContent = "▾";
      b.title = "Filtrează după " + nume[i];
      b.setAttribute("aria-label", "Filtrează după " + nume[i]);
      // Clicul pe ▾ nu sortează coloana: sortarea ascultă pe document.
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        deschide(i, b);
      });
      th.appendChild(b);
    });
    if (bara) {
      var s = bara.querySelector("[data-sterge]");
      if (s) s.addEventListener("click", function () {
        stare = {};
        scrie(cheieTabel, stare);
        inchide();
        aplica();
      });
    }
    // Un filtru ținut minte pe o coloană care nu mai există nu are voie să
    // ascundă tot tabelul fără să se vadă de ce.
    Object.keys(stare).forEach(function (k) {
      if (!capete[k] || !capete[k].querySelector(".filtru-btn")) delete stare[k];
    });
    aplica();
  }

  document.querySelectorAll("table[data-filtre]").forEach(porneste);
}

const STIL = `<style>
.filtru-btn { margin-left:4px; border:1px solid transparent; background:transparent; color:var(--text-muted,#667085); border-radius:4px; padding:0 4px; font-size:11px; line-height:16px; cursor:pointer; vertical-align:middle; }
.filtru-btn:hover { border-color:var(--border,#d0d5dd); background:#fff; color:var(--primary,#2f5d9c); }
.filtru-btn.activ { background:var(--primary,#2f5d9c); border-color:var(--primary,#2f5d9c); color:#fff; }
.filtru-pop { position:absolute; z-index:1000; width:300px; max-width:calc(100vw - 16px); box-sizing:border-box; background:#fff; color:var(--text,#111); border:1px solid var(--border,#d0d5dd); border-radius:8px; box-shadow:0 8px 24px rgba(16,24,40,.16); padding:8px; font-size:13px; font-weight:400; text-align:left; }
.filtru-cauta { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border,#d0d5dd); border-radius:6px; margin-bottom:6px; font:inherit; }
.filtru-tot { display:flex; gap:6px; align-items:center; padding:4px 2px; border-bottom:1px solid var(--border,#eaecf0); margin-bottom:4px; cursor:pointer; }
.filtru-lista { max-height:280px; overflow:auto; }
.filtru-lista label { display:flex; gap:6px; align-items:center; padding:3px 2px; cursor:pointer; border-radius:4px; }
.filtru-lista label:hover { background:var(--bg-subtle,#f6f7f9); }
.filtru-v { overflow-wrap:anywhere; }
.filtru-n { margin-left:auto; padding-left:8px; color:var(--text-muted,#667085); font-size:11px; }
.filtru-nimic { color:var(--text-muted,#667085); padding:6px 2px; }
.filtru-jos { display:flex; justify-content:space-between; gap:8px; margin-top:8px; padding-top:6px; border-top:1px solid var(--border,#eaecf0); }
.filtru-jos button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid var(--border,#d0d5dd); background:#fff; cursor:pointer; }
.filtru-jos .filtru-ok { background:var(--primary,#2f5d9c); border-color:var(--primary,#2f5d9c); color:#fff; }
.filtre-bara { display:flex; flex-wrap:wrap; gap:6px 16px; align-items:center; margin:4px 0 8px; font-size:13px; color:var(--text-muted,#667085); }
.filtre-bara [data-total] { font-weight:600; color:var(--text,#111); }
</style>`;

function script() {
  return `${STIL}<script>(${filtreTabel.toString()})();</script>`;
}

// Bara de deasupra tabelului: câte rânduri se văd, totalul, „Șterge filtrele".
function bara(cheie) {
  return `<div class="filtre-bara" data-filtre-pentru="${cheie}"><span data-numar></span><span data-total></span><button type="button" class="link-btn" data-sterge hidden>Șterge filtrele</button></div>`;
}

module.exports = { filtreTabel, script, bara, STIL };
