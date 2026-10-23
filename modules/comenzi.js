"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks, cautaClient, cautaClientScript, randuriClienti } = require("../lib/render");
const { perioadaDin, chipuriPerioada } = require("../lib/perioada");
const { send, redirect } = require("../lib/router");
const livrare = require("../lib/livrare-partiala");

// Stările comenzii și bara de pași stau în lib/comenzi-stari.js: le citește
// și depozitul, iar o a doua copie aici ar fi rămas în urmă la prima
// modificare. Vezi comentariul de acolo.
const stari = require("../lib/comenzi-stari");
const { STATUS_LABEL, poateFactura, bara: baraStatus } = stari;

// Moneda comenzii și unitățile cu care se lucrează. Moneda stă pe comandă, nu
// pe linie: o comandă în două monede n-are total, iar un total care nu se
// poate aduna n-ajută pe nimeni. Unitatea stă pe linie, fiindcă acolo se
// schimbă — aceeași folie se comandă și la rolă, și la kilogram.
const MONEDE = ["RON", "EUR", "USD"];
const UNITATI = ["buc", "kg", "ml", "mp", "rolă", "palet", "set", "litru", "tonă", "cutie", "bax"];
const SIMBOL = { RON: "lei", EUR: "€", USD: "$" };
const sumaIn = (v, moneda) =>
  Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  " " +
  (SIMBOL[moneda] || moneda || "lei");

// ------------------------------------------------------------------
// Anuntul de comanda noua
// ------------------------------------------------------------------
// Pe langa fluxul din ERP (comanda intra in lista depozitului), comanda pleaca
// si pe email: la biroul firmei, la Mihai si inapoi la agentul care a plasat-o,
// ca sa aiba dovada scrisa fara sa intre in aplicatie. Adresele stau in
// setari_app, deci se schimba din baza fara sa mai umblam prin cod.
// 09.10.2026: anunțul nu mai pleacă la office@, ci la comercial@ — cererea lui
// Vali. Restul adreselor rămân cum erau. Cine vrea altceva fără deploy pune
// cheia „comanda_noua_catre" în setari_app, care bate valoarea de aici.
const CATRE_IMPLICIT = "comercial@cashmachine.ro, mihai.mosneanu@cashmachine.ro";

function adreseDinText(text) {
  return String(text || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

async function destinatariComandaNoua(agentEmail) {
  let brut = CATRE_IMPLICIT;
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'comanda_noua_catre'").get();
    if (r && String(r.valoare || "").trim()) brut = r.valoare;
  } catch (e) {
    // setarea lipseste: ramanem pe adresele implicite
  }
  const lista = adreseDinText(brut);
  for (const a of adreseDinText(agentEmail)) lista.push(a);
  const vazute = new Set();
  return lista.filter((a) => {
    const k = a.toLowerCase();
    if (vazute.has(k)) return false;
    vazute.add(k);
    return true;
  });
}

async function expeditorEmail(user) {
  const mail = require("../lib/mail");
  const candidati = [];
  if (user && user.id) candidati.push(user.id);
  for (const r of await db
    .prepare("SELECT id FROM utilizatori WHERE activ = 1 AND smtp_host IS NOT NULL ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id")
    .all())
    candidati.push(r.id);
  for (const id of candidati) {
    const u = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(id);
    const cfg = u && mail.configUtilizator(u);
    if (cfg) return { user: u, config: cfg };
  }
  return null;
}

async function anuntaComandaNoua(comandaId, user) {
  const mail = require("../lib/mail");
  const c = await db
    .prepare(
      `SELECT c.*, p.nume AS client, p.telefon AS client_telefon, p.email AS client_email, u.nume AS agent, u.email AS agent_email
         FROM comenzi c
         JOIN parteneri p ON p.id = c.partener_id
         LEFT JOIN utilizatori u ON u.id = c.agent_id
        WHERE c.id = ?`
    )
    .get(comandaId);
  if (!c) return { status: "esuat", eroare: "comanda nu a fost gasita" };

  const linii = await db
    .prepare(
      `SELECT cl.cantitate, cl.pret_unitar, cl.um, pr.denumire, pr.unitate_masura
         FROM comenzi_linii cl JOIN produse pr ON pr.id = cl.produs_id
        WHERE cl.comanda_id = ?`
    )
    .all(comandaId);
  const total = linii.reduce((s, l) => s + Number(l.cantitate) * Number(l.pret_unitar), 0);
  // Emailul scrie moneda comenzii, nu „lei" din reflex: o comandă în euro
  // anunțată în lei e o cifră greșită trimisă la trei oameni deodată.
  const lei = (v) => sumaIn(v, c.moneda);

  const subiect = `Comandă nouă ${c.numar ? c.numar + " " : ""}#${c.id} — ${c.client}`;
  const corp = [
    `Comandă nouă în ERP.`,
    ``,
    `Client:   ${c.client}${c.client_telefon ? " · " + c.client_telefon : ""}${c.client_email ? " · " + c.client_email : ""}`,
    `Agent:    ${c.agent || "—"}`,
    `Număr:    ${c.numar || "(fără număr)"} (id ${c.id})`,
    `Livrare cerută: ${c.data_livrare_ceruta || "—"}`,
    ``,
    `Produse:`,
    ...linii.map((l) => `  - ${l.denumire} — ${l.cantitate} ${l.um || l.unitate_masura || "buc"} × ${lei(l.pret_unitar)} = ${lei(Number(l.cantitate) * Number(l.pret_unitar))}`),
    ``,
    `Total fără TVA: ${lei(total)}`,
    c.observatii ? `\nObservații: ${c.observatii}` : "",
    ``,
    `Comanda: ${(process.env.ERP_URL || "https://erp-cashmachine-app.onrender.com").replace(/\/$/, "")}/comenzi/${c.id}`,
  ].join("\n");

  const catre = await destinatariComandaNoua(c.agent_email || (user && user.email));
  let status = "trimis";
  let eroare = null;
  if (!catre.length) {
    status = "esuat";
    eroare = "Nu e configurată nicio adresă pentru anunțul de comandă nouă.";
  } else {
    const exp = await expeditorEmail(user);
    if (!exp) {
      status = "esuat";
      eroare = "Niciun utilizator nu are contul de email configurat (Profilul meu → Email).";
    } else {
      try {
        await mail.trimite(exp.config, { catre, subiect, corp });
      } catch (e) {
        status = "esuat";
        eroare = e.message;
      }
    }
  }

  try {
    await db
      .prepare(
        `INSERT INTO emailuri (utilizator_id, partener_id, catre, subiect, corp, status, eroare)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(user && user.id ? user.id : null, c.partener_id, catre.join(", ") || "—", subiect, corp, status, eroare);
  } catch (e) {
    console.error("[comenzi] nu am putut scrie emailul in istoric:", e.message);
  }
  return { status, eroare, catre };
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Produsele pleacă o singură dată în pagină, ca date, nu ca mii de
// `<option>` clonate pe fiecare linie. Normalizarea pentru căutare se face
// în browser, la încărcare: un al doilea exemplar al fiecărei denumiri, scris
// în HTML, ar fi dublat degeaba pagina.
//
// MAX_REZULTATE ține lista scurtă. Fără el, o categorie cu 400 de articole
// desenează 400 de rânduri la fiecare literă tastată și câmpul se mișcă greu
// exact când omul scrie mai repede.
const MAX_REZULTATE = 40;

function lineRowsScript(produse) {
  const date = (produse || []).map((p) => [
    p.id,
    String(p.cod || ""),
    String(p.denumire || ""),
    Number(p.pret_vanzare || 0),
    String(p.categorie || "").trim(),
    "", // locul cheii de căutare, umplută mai jos
    String(p.unitate_masura || "").trim(),
  ]);
  return `<script>
    var COMENZI_PRODUSE = ${JSON.stringify(date).replace(/</g, "\\u003c")};
    var COMENZI_MAX = ${MAX_REZULTATE};
    (function () {
      var fara = function (s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
      };
      COMENZI_PRODUSE.forEach(function (p) { p[5] = fara(p[1] + ' ' + p[2]); });
      window.comenziFaraDiacritice = fara;
    })();

    function comenziRand(el) { return el.closest('tr'); }

    // Lista de rezultate stă pe „fixed", nu pe „absolute".
    //
    // Pe „absolute" se desena corect, dar se vedea doar o dungă de câțiva
    // pixeli: rândul e o celulă de tabel, iar undeva deasupra există un
    // overflow pentru derularea pe orizontală. Orice strămoș cu overflow
    // taie un element poziționat absolut, oricât de mare i-ar fi z-index-ul.
    // „Fixed" îl scoate din tabel cu totul, iar poziția o calculăm noi din
    // dreptunghiul câmpului. Prețul: trebuie repusă la derulare și la
    // redimensionare, de-aia cele două ascultători de mai jos.
    function comenziAseaza(cutie, input) {
      var r = input.getBoundingClientRect();
      var subSpatiu = window.innerHeight - r.bottom - 8;
      cutie.style.left = r.left + 'px';
      cutie.style.width = r.width + 'px';
      // Dacă nu încape dedesubt, o punem deasupra câmpului.
      if (subSpatiu < 140 && r.top > subSpatiu) {
        cutie.style.top = 'auto';
        cutie.style.bottom = (window.innerHeight - r.top + 4) + 'px';
        cutie.style.maxHeight = Math.max(120, r.top - 12) + 'px';
      } else {
        cutie.style.bottom = 'auto';
        cutie.style.top = (r.bottom + 4) + 'px';
        cutie.style.maxHeight = Math.max(120, subSpatiu) + 'px';
      }
    }
    function comenziReaseaza() {
      document.querySelectorAll('.rezultate-produs').forEach(function (cutie) {
        if (cutie.hidden) return;
        var input = cutie.parentNode.querySelector('.cauta-produs');
        if (input) comenziAseaza(cutie, input);
      });
    }
    window.addEventListener('scroll', comenziReaseaza, true);
    window.addEventListener('resize', comenziReaseaza);

    // Filtrul de categorie: golește produsul ales dacă nu mai e în categorie,
    // ca să nu rămână pe linie un articol care contrazice filtrul de deasupra.
    function comenziFiltreaza(select) {
      var rand = comenziRand(select);
      var cautare = rand.querySelector('.cauta-produs');
      var ascuns = rand.querySelector('input[name="produs_id[]"]');
      if (ascuns && ascuns.value) {
        var ales = COMENZI_PRODUSE.find(function (p) { return String(p[0]) === String(ascuns.value); });
        var cat = select.value === '\\u0000' ? '' : select.value;
        if (ales && select.value && ales[4] !== cat) { ascuns.value = ''; cautare.value = ''; }
      }
      cautare.focus();
      comenziCauta(cautare);
    }

    function comenziCauta(input) {
      var rand = comenziRand(input);
      var cutie = rand.querySelector('.rezultate-produs');
      var catSel = rand.querySelector('.cat-produs');
      var cat = catSel ? catSel.value : '';
      var q = window.comenziFaraDiacritice(input.value).trim();
      var gasite = [];
      for (var i = 0; i < COMENZI_PRODUSE.length && gasite.length < COMENZI_MAX; i++) {
        var p = COMENZI_PRODUSE[i];
        if (cat === '\\u0000') { if (p[4]) continue; }
        else if (cat && p[4] !== cat) continue;
        if (q && p[5].indexOf(q) === -1) continue;
        gasite.push(p);
      }
      if (!gasite.length) {
        cutie.innerHTML = '<div class="rezultat-gol">Niciun produs aici. Schimbă categoria sau scrie altceva.</div>' +
                          comenziButonNou(input.value);
        cutie.hidden = false;
        comenziAseaza(cutie, input);
        return;
      }
      cutie.innerHTML = gasite.map(function (p) {
        var cod = p[1] ? '<span class="rezultat-cod">' + p[1] + '</span> ' : '';
        var catTxt = p[4] ? '<span class="rezultat-cat">' + p[4] + '</span>' : '';
        return '<button type="button" class="rezultat-produs" data-id="' + p[0] + '" data-pret="' + p[3] +
               '" onclick="comenziAlege(this)">' + cod + p[2] + ' ' + catTxt + '</button>';
      }).join('') + comenziButonNou(input.value);
      cutie.hidden = false;
      comenziAseaza(cutie, input);
    }

    // „+ Adaugă ... ca produs nou"
    //
    // Butonul apare si cand lista ARE rezultate, nu doar cand e goala: cazul
    // real e tocmai acela in care se vad patru benzi adezive si niciuna nu e
    // aia ceruta. Daca ar aparea doar pe lista goala, omul ar trebui sa scrie
    // intentionat o prostie ca sa ajunga la el.
    function comenziEscHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function comenziButonNou(q) {
      var t = String(q || '').trim();
      if (t.length < 3) return '';
      return '<button type="button" class="rezultat-nou" onclick="comenziProdusNou(this)">' +
             '+ Adaugă „' + comenziEscHtml(t) + '” ca produs nou</button>';
    }

    // Ce scrie omul nu se interpoleaza in cod: butonul nu poarta denumirea cu
    // el, o citeste din campul randului in momentul apasarii.
    function comenziProdusNou(btn) {
      var rand = comenziRand(btn);
      var cautare = rand.querySelector('.cauta-produs');
      var catSel = rand.querySelector('.cat-produs');
      var umInput = rand.querySelector('.um-linie');
      var cutie = rand.querySelector('.rezultate-produs');
      var denumire = cautare.value.trim();
      if (denumire.length < 3) return;
      var cat = (catSel && catSel.value && catSel.value !== '\\u0000') ? catSel.value : '';

      btn.disabled = true;
      var textInitial = btn.textContent;
      btn.textContent = 'Se adaugă…';
      var opreste = function (mesaj) {
        btn.disabled = false;
        btn.textContent = textInitial;
        var av = cutie.querySelector('.rezultat-eroare');
        if (!av) { av = document.createElement('div'); av.className = 'rezultat-eroare'; cutie.appendChild(av); }
        av.textContent = mesaj;
      };

      fetch('/produse/rapid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ denumire: denumire, categorie: cat, um: umInput ? umInput.value.trim() : '' })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d || !res.d.id) {
            return opreste((res.d && res.d.eroare) || 'Nu am putut adăuga produsul. Încearcă din nou.');
          }
          var d = res.d;
          // Intra si in lista din pagina, ca sa fie gasibil pe celelalte randuri
          // fara reincarcare. Fara asta, doua linii cu acelasi produs nou ar
          // insemna doua apasari si doua cautari in baza.
          if (!COMENZI_PRODUSE.some(function (x) { return String(x[0]) === String(d.id); })) {
            var p = [d.id, d.cod || '', d.denumire, Number(d.pret || 0), d.categorie || '', '', d.um || ''];
            p[5] = window.comenziFaraDiacritice(p[1] + ' ' + p[2]);
            COMENZI_PRODUSE.push(p);
          }
          rand.querySelector('input[name="produs_id[]"]').value = d.id;
          cautare.value = d.denumire;
          if (umInput && !umInput.value && d.um) umInput.value = d.um;
          var pretInput = rand.querySelector('input[name="pret_unitar[]"]');
          if (pretInput && !pretInput.value && Number(d.pret) > 0) pretInput.value = d.pret;
          cutie.hidden = true;
          var cant = rand.querySelector('input[name="cantitate[]"]');
          if (cant && !cant.value) cant.focus();
        })
        .catch(function () { opreste('Nu am putut adăuga produsul. Verifică legătura și încearcă din nou.'); });
    }

    function comenziAlege(btn) {
      var rand = comenziRand(btn);
      var id = btn.getAttribute('data-id');
      var pret = btn.getAttribute('data-pret');
      var p = COMENZI_PRODUSE.find(function (x) { return String(x[0]) === String(id); });
      rand.querySelector('input[name="produs_id[]"]').value = id;
      rand.querySelector('.cauta-produs').value = p ? p[2] : '';
      rand.querySelector('.rezultate-produs').hidden = true;
      var pretInput = rand.querySelector('input[name="pret_unitar[]"]');
      if (pretInput && pret && !pretInput.value) pretInput.value = pret;
      // Unitatea vine din nomenclator, dar rămâne schimbabilă: se comandă și
      // altfel decât e trecut pe produs (bobina în kg, deși produsul stă în
      // bucăți). Ce a scris omul nu se rescrie.
      var umInput = rand.querySelector('.um-linie');
      if (umInput && !umInput.value && p && p[6]) umInput.value = p[6];
      var cant = rand.querySelector('input[name="cantitate[]"]');
      if (cant && !cant.value) cant.focus();
    }

    // Click în afară: lista se închide, dar produsul ales rămâne. Dacă omul a
    // scris ceva și n-a apăsat pe nimic, textul se șterge — altfel ar rămâne
    // pe ecran o denumire pe jumătate scrisă lângă o linie fără produs.
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.alege-produs').forEach(function (sp) {
        if (sp.contains(e.target)) return;
        sp.querySelector('.rezultate-produs').hidden = true;
        var ascuns = sp.querySelector('input[name="produs_id[]"]');
        var cautare = sp.querySelector('.cauta-produs');
        if (!ascuns.value) cautare.value = '';
      });
    });

    function comenziAddRow() {
      var tbody = document.getElementById('linii-body');
      var clone = tbody.querySelector('tr').cloneNode(true);
      clone.querySelectorAll('input').forEach(function (el) { el.value = ''; });
      clone.querySelectorAll('select').forEach(function (el) { el.selectedIndex = 0; });
      var cutie = clone.querySelector('.rezultate-produs');
      if (cutie) { cutie.innerHTML = ''; cutie.hidden = true; }
      tbody.appendChild(clone);
      clone.querySelector('.cat-produs').focus();
    }
    function comenziRemoveRow(btn) {
      var tbody = document.getElementById('linii-body');
      if (tbody.children.length > 1) btn.closest('tr').remove();
    }
  </script>
  <style>
    /* fixed, nu absolute: vezi comentariul din comenziAseaza. left/top/width
       le pune JS-ul din dreptunghiul câmpului. */
    .rezultate-produs { position:fixed; z-index:400; max-height:300px; overflow-y:auto; min-width:240px;
      background:var(--card,#fff); border:1px solid var(--border,#ddd); border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,.18); }
    .rezultat-produs { display:block; width:100%; text-align:left; padding:6px 10px; border:0; background:none; cursor:pointer; font-size:13px; }
    .rezultat-produs:hover { background:var(--accent-slab,#e8f0fe); }
    .rezultat-cod { color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .rezultat-cat { color:var(--text-muted); font-size:11px; }
    .rezultat-gol { padding:8px 10px; color:var(--text-muted); font-size:13px; }
    /* Se desparte de rezultate printr-o linie: e o actiune, nu inca un produs
       din lista peste care treci din greseala. */
    .rezultat-nou { display:block; width:100%; text-align:left; padding:8px 10px; border:0;
      border-top:1px solid var(--border,#ddd); background:none; cursor:pointer; font-size:13px;
      color:var(--accent,#1a56db); font-weight:600; }
    .rezultat-nou:hover { background:var(--accent-slab,#e8f0fe); }
    .rezultat-nou[disabled] { opacity:.6; cursor:default; }
    .rezultat-eroare { padding:6px 10px; color:var(--danger,#b42318); font-size:12px; }
  </style>`;
}

function register(router) {
  router.get("/comenzi", async (ctx) => {
    const per = perioadaDin(ctx.query, "tot");
    const comenzi = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume,
                COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
         FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
         WHERE c.data >= ? AND c.data <= ?
         ORDER BY c.id DESC`
      )
      .all(per.de, per.la + " 23:59:59");
    const body = `
      <div class="toolbar"><a href="/comenzi/nou" class="btn">+ Comandă nouă</a></div>
      <form class="filtre perioade" method="get" action="/comenzi">
        <span class="perioade-titlu">Perioada</span>
        ${chipuriPerioada(per.cheie)}
        <span class="perioade-custom">
          <input type="date" name="de_la" value="${esc(per.de)}">
          <span class="perioade-sageata">→</span>
          <input type="date" name="pana_la" value="${esc(per.la)}">
          <button class="chip${per.cheie === "custom" ? " activ" : ""}" type="submit" name="perioada" value="custom">Aplică</button>
        </span>
      </form>
      ${table(
        ["Nr.", "Client", "Data", "Status", "Total", "Acțiuni"],
        comenzi.map((c) => [
          `<a href="/comenzi/${c.id}">${esc(c.numar || "#" + c.id)}</a>`,
          esc(c.partener_nume),
          esc(c.data),
          STATUS_LABEL[c.status] || esc(c.status),
          money(c.total),
          actionLinks([{ href: `/comenzi/${c.id}`, label: "Deschide" }]),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comenzi", active: "/comenzi", body }));
  });

  // Formularul de comandă nouă, redat și la deschidere și când salvarea a fost
  // oprită. Ce a scris omul se întoarce cu el: o comandă cu zece linii nu se
  // tastează de două ori pentru că a uitat clientul.
  async function formularComandaNoua(ctx, { eroare, valori } = {}) {
    const v = valori || {};
    // Toți clienții din bază, nu doar ai agentului: căutarea de mai jos merge pe
    // orice bucată din nume sau din CUI, iar lângă fiecare firmă scrie al cui
    // client e.
    const parteneri = await db
      .prepare("SELECT id, nume, cui, agent_id FROM parteneri WHERE tip != 'furnizor' ORDER BY nume")
      .all();
    const agentiToti = await db.prepare("SELECT id, nume FROM utilizatori ORDER BY nume").all();
    // Produsele unificate (activ = 0) nu mai pot fi alese: altfel codul înghițit
    // ar renaște ca duplicat chiar din formularul de comandă.
    const produse = await db
      .prepare("SELECT id, cod, denumire, pret_vanzare, categorie, unitate_masura FROM produse WHERE activ = 1 ORDER BY denumire")
      .all();
    if (parteneri.length === 0 || produse.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user,
          title: "Comandă nouă",
          active: "/comenzi",
          body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">client</a> și un <a href="/produse/nou">produs</a>.</p>`,
        })
      );
    }
    // Alegerea produsului: întâi categoria, apoi căutarea în ea.
    //
    // Până acum fiecare linie avea o listă derulantă cu TOATE produsele —
    // peste patru mii de rânduri — iar butonul „+ Adaugă linie" clona rândul
    // cu tot cu listă. Trei linii pe comandă însemnau douăsprezece mii de
    // elemente în pagină, și oricum nu se putea căuta în ele: lista nativă
    // sare doar la prima literă tastată, deci o folie din mijlocul
    // alfabetului se găsea derulând.
    //
    // Acum produsele se trimit o singură dată, ca date, iar fiecare linie are
    // un filtru de categorie și o căsuță de căutare. Căutarea merge pe cod și
    // pe denumire, fără diacritice, oriunde în text — nu doar la început.
    const categorii = [...new Set(produse.map((p) => String(p.categorie || "").trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "ro")
    );
    const faraCategorie = produse.some((p) => !String(p.categorie || "").trim());
    const optiuniCategorie = (aleasa) =>
      [`<option value="">— toate categoriile —</option>`]
        .concat(
          categorii.map(
            (c) => `<option value="${esc(c)}"${String(aleasa || "") === c ? " selected" : ""}>${esc(c)}</option>`
          )
        )
        .concat(faraCategorie ? [`<option value="\u0000"${String(aleasa || "") === "\u0000" ? " selected" : ""}>(fără categorie)</option>`] : [])
        .join("");

    const numeProdus = (id) => {
      const p = produse.find((x) => String(x.id) === String(id));
      return p ? p.denumire : "";
    };
    const categoriaProdusului = (id) => {
      const p = produse.find((x) => String(x.id) === String(id));
      return p ? String(p.categorie || "").trim() : "";
    };
    const unitateaProdusului = (id) => {
      const p = produse.find((x) => String(x.id) === String(id));
      return p ? String(p.unitate_masura || "").trim() : "";
    };

    const randLinie = (l) => `<tr>
            <td style="min-width:150px">
              <select class="cat-produs" onchange="comenziFiltreaza(this)">${optiuniCategorie(categoriaProdusului(l.produs_id))}</select>
            </td>
            <td style="min-width:260px">
              <span class="alege-produs" style="position:relative;display:block">
                <input type="hidden" name="produs_id[]" value="${esc(l.produs_id || "")}">
                <input type="search" class="cauta-produs" autocomplete="off" style="width:100%"
                       placeholder="scrie din cod sau denumire" value="${esc(numeProdus(l.produs_id))}"
                       oninput="comenziCauta(this)" onfocus="comenziCauta(this)">
                <div class="rezultate-produs" hidden></div>
              </span>
            </td>
            <td><input type="number" step="0.01" name="cantitate[]" value="${esc(l.cantitate || "")}"></td>
            <td><input class="um-linie" name="um[]" list="comenzi-unitati" style="width:84px" placeholder="UM"
                       value="${esc(l.um || unitateaProdusului(l.produs_id))}"></td>
            <td><input type="number" step="0.01" name="pret_unitar[]" value="${esc(l.pret_unitar || "")}"></td>
            <td><button type="button" class="link-btn danger" onclick="comenziRemoveRow(this)">Șterge</button></td>
          </tr>`;

    // Liniile scrise deja, dacă salvarea a fost oprită. Altfel, un rând gol.
    const linii = Array.isArray(v.linii) && v.linii.length ? v.linii : [{}];

    const body = `
    ${
      eroare
        ? `<p class="alerta" style="max-width:820px;color:var(--danger);border:1px solid var(--danger);border-radius:8px;padding:10px 12px">${esc(eroare)}</p>`
        : ""
    }
    <form method="post" action="/comenzi" class="form" style="max-width:820px">
      <label class="field"><span>Client</span>
        ${cautaClient({
          nume: "client_cautat",
          obligatoriu: true,
          partenerId: v.partener_id,
          valoare: (parteneri.find((p) => String(p.id) === String(v.partener_id)) || {}).nume,
        })}
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr 140px;gap:14px">
        <label class="field"><span>Număr comandă (opțional)</span><input type="text" name="numar" value="${esc(v.numar || "")}"></label>
        <label class="field"><span>Termen cerut de client</span><input type="date" name="data_livrare_ceruta" value="${esc(v.data_livrare_ceruta || "")}"></label>
        <label class="field"><span>Moneda</span>
          <select name="moneda">
            ${MONEDE.map((m) => `<option value="${m}"${String(v.moneda || "RON") === m ? " selected" : ""}>${m}</option>`).join("")}
          </select>
        </label>
      </div>
      <fieldset class="field" style="border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px">
        <legend style="font-size:13px;padding:0 4px">Dacă nu e toată marfa pe stoc, clientul acceptă livrare parțială?</legend>
        <label style="display:inline-flex;align-items:center;gap:6px;margin-right:18px">
          <input type="radio" name="livrare_partiala" value="da" required${v.livrare_partiala === "da" ? " checked" : ""}>
          <span>Da — trimitem ce e acum, restul mai târziu</span>
        </label>
        <label style="display:inline-flex;align-items:center;gap:6px">
          <input type="radio" name="livrare_partiala" value="nu" required${v.livrare_partiala === "nu" ? " checked" : ""}>
          <span>Nu — doar comanda completă</span>
        </label>
        <div class="mic" style="color:var(--text-muted);margin-top:6px">
          Întreabă clientul acum, nu peste trei zile. Depozitul nu are voie să trimită jumătate de comandă fără răspunsul ăsta.
        </div>
      </fieldset>

      <label class="field"><span>Observații</span><textarea name="observatii" rows="2">${esc(v.observatii || "")}</textarea></label>

      <h2>Produse comandate</h2>
      <table class="table lines-table">
        <thead><tr><th>Categorie</th><th>Produs</th><th style="min-width:120px">Cantitate</th><th style="min-width:96px">UM</th><th style="min-width:130px">Preț unitar</th><th></th></tr></thead>
        <tbody id="linii-body">
          ${linii.map(randLinie).join("")}
        </tbody>
      </table>
      <button type="button" class="btn secondary small" onclick="comenziAddRow()">+ Adaugă linie</button>

      <div class="form-actions">
        <button type="submit" class="btn">Salvează comanda</button>
        <a href="/comenzi" class="btn secondary">Renunță</a>
      </div>
    </form>
    <datalist id="comenzi-unitati">${UNITATI.map((u) => `<option value="${u}">`).join("")}</datalist>
    ${cautaClientScript(randuriClienti(parteneri, agentiToti))}
    ${lineRowsScript(produse)}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă", active: "/comenzi", body }));
  }

  router.get("/comenzi/nou", async (ctx) => {
    await formularComandaNoua(ctx);
  });

  router.post("/comenzi", async (ctx) => {
    const { partener_id, numar, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const unitati = asArray(ctx.body["um[]"]);
    // Ce vine prin HTTP nu se crede pe cuvânt: o monedă necunoscută ar ajunge
    // scrisă pe comandă și pe factura de după ea.
    const moneda = MONEDE.includes(String(ctx.body.moneda || "")) ? String(ctx.body.moneda) : "RON";

    // ---- clientul e obligatoriu ------------------------------------------
    //
    // Cererea lui Vali. Până acum lista de clienți n-avea rând gol, deci
    // PRIMUL client din alfabet era ales din start: un agent care uita să
    // aleagă nu primea nicio eroare — comanda pleca, corectă în toate privințele
    // în afară de firma pe care era trecută. Iar dacă lipsea de tot
    // (formular trimis din altă parte), inserarea crăpa cu 500, fiindcă
    // partener_id e NOT NULL în bază.
    //
    // Acum lista începe cu „— alege clientul —", iar aici se verifică din nou:
    // ce vine prin HTTP nu se crede pe cuvânt, oricât de strict ar fi
    // formularul. Ce a scris omul se întoarce cu el, ca să nu retasteze.
    const valori = {
      partener_id,
      numar,
      observatii,
      data_livrare_ceruta: ctx.body.data_livrare_ceruta,
      livrare_partiala: livrare.valid(ctx.body.livrare_partiala),
      moneda,
      linii: produsIds.map((id, i) => ({ produs_id: id, cantitate: cantitati[i], pret_unitar: preturi[i], um: unitati[i] })),
    };
    const idClient = parseInt(partener_id, 10);
    if (!idClient) {
      return await formularComandaNoua(ctx, { eroare: "Alege clientul — o comandă nu poate exista fără el.", valori });
    }
    const client = await db.prepare("SELECT id FROM parteneri WHERE id = ?").get(idClient);
    if (!client) {
      return await formularComandaNoua(ctx, { eroare: "Clientul ales nu mai există în ERP. Alege altul.", valori });
    }
    // O comandă fără nicio linie cu cantitate e tot o comandă goală: intră în
    // lista depozitului și nu are ce se potrivi cu stocul.
    if (!produsIds.some((id, i) => Number(cantitati[i] || 0) > 0)) {
      return await formularComandaNoua(ctx, {
        eroare: "Scrie cel puțin o linie cu cantitate — altfel comanda ajunge goală la depozit.",
        valori,
      });
    }

    // O linie cu cantitate, dar fără produs ales.
    //
    // Înainte nu se putea întâmpla: lista derulantă avea mereu ceva selectat.
    // Acum produsul se caută, iar câmpul ascuns rămâne gol până se apasă pe
    // un rezultat — deci se poate scrie o cantitate lângă un produs doar
    // tastat, nu și ales. Fără verificarea asta, inserarea cădea cu 500 pe
    // `produs_id` NOT NULL, iar omul vedea o pagină de eroare în loc să afle
    // că n-a apăsat pe produs.
    const liniiFaraProdus = produsIds.filter((id, i) => Number(cantitati[i] || 0) > 0 && !parseInt(id, 10)).length;
    if (liniiFaraProdus) {
      return await formularComandaNoua(ctx, {
        eroare:
          liniiFaraProdus === 1
            ? "O linie are cantitate, dar niciun produs ales. Caută produsul și apasă pe el în listă."
            : `${liniiFaraProdus} linii au cantitate, dar niciun produs ales. Caută produsul și apasă pe el în listă.`,
        valori,
      });
    }

    // Livrarea parțială se întreabă acum, nu după ce depozitul descoperă că
    // lipsește marfă. Radio-urile din formular au `required`, dar ce vine prin
    // HTTP nu se crede pe cuvânt: o comandă trimisă din altă parte ar intra
    // fără răspuns, iar depozitul ar rămâne iar cu întrebarea în brațe.
    if (!valori.livrare_partiala) {
      return await formularComandaNoua(ctx, {
        eroare: "Spune dacă clientul acceptă livrare parțială. Depozitul nu are ce face cu o comandă fără răspunsul ăsta.",
        valori,
      });
    }

    // Client pe roșu = fără comenzi noi de la agent. Adminul poate trece
    // peste, dar conștient — nu din reflex.
    const verdict = await require("./scadente").poateComanda(ctx.user, partener_id);
    if (!verdict.ok) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Comandă blocată",
          active: "/comenzi",
          body: `<h1>Comandă blocată</h1>
            <p style="color:var(--danger);max-width:640px">${esc(verdict.motiv)}</p>
            <p style="max-width:640px;color:var(--text-muted)">Dacă e o situație pe care ai discutat-o deja cu clientul,
              vorbește cu administratorul: el poate plasa comanda sau poate marca restanța ca rezolvată.</p>
            <a class="btn secondary" href="/parteneri/${esc(String(partener_id))}">Vezi clientul</a>
            <a class="btn secondary" href="/scadente">Scadențele mele</a>`,
        })
      );
    }

    const info = await db
      .prepare(
        "INSERT INTO comenzi (partener_id, numar, observatii, agent_id, data_livrare_ceruta, livrare_partiala, moneda) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .run(
        partener_id,
        numar || "",
        observatii || "",
        ctx.user ? ctx.user.id : null,
        String(ctx.body.data_livrare_ceruta || "") || null,
        valori.livrare_partiala,
        moneda
      );
    const comandaId = info.lastInsertRowid;

    const insertLinie = db.prepare(
      "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < produsIds.length; i++) {
      const cant = Number(cantitati[i] || 0);
      const produsId = parseInt(produsIds[i], 10);
      if (cant > 0 && produsId) {
        await insertLinie.run(comandaId, produsId, cant, Number(preturi[i] || 0), String(unitati[i] || "").trim() || null);
      }
    }

    // Anuntul pe email nu are voie sa strice plasarea comenzii: daca serverul
    // de mail e picat, comanda ramane, iar esecul se vede in istoricul de
    // emailuri, cu motivul scris pe el.
    try {
      await anuntaComandaNoua(comandaId, ctx.user);
    } catch (e) {
      console.error("[comenzi] anunt comanda noua:", e.message);
    }

    // Comanda NU mai pleacă direct în producție. Drumul ei e cel cerut de
    // Vali: intră în lista depozitului („comenzi deschise"), acolo se face
    // potrivirea cu stocul, și abia dacă marfa lipsește depozitul o comandă
    // mai departe — la un terț sau la producție. Vezi modules/warehouse.js.
    redirect(ctx.res, `/comenzi/${comandaId}`);
  });

  router.get("/comenzi/:id", async (ctx) => {
    const comanda = await db
      .prepare(`SELECT c.*, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?`)
      .get(ctx.params.id);
    if (!comanda) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/comenzi", body: "<p>Comandă inexistentă.</p>" }));

    const linii = await db
      .prepare(
        `SELECT cl.*, p.denumire, p.unitate_masura FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`
      )
      .all(comanda.id);
    const total = linii.reduce((s, l) => s + l.cantitate * l.pret_unitar, 0);
    const facturi = await db
      .prepare("SELECT id, serie, numar, status FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE comanda_id = ? ORDER BY id")
      .all(comanda.id);
    const factura = facturi[0] || null;

    // Cum stă comanda față de stoc — aceeași socoteală pe care o vede și
    // depozitul, ca agentul să nu întrebe pe telefon „a venit marfa?".
    const warehouse = require("./warehouse");
    let stoc = { linii: [], acoperiteTot: false, acoperitePartial: false };
    try {
      stoc = await warehouse.potrivire(comanda.id);
    } catch (e) {
      console.error("[comenzi] potrivire cu stocul:", e.message);
    }
    const stocPeLinie = new Map(stoc.linii.map((l) => [Number(l.id), l]));
    const rezervareActiva = stoc.linii.find((l) => l.rezervare);
    const aprovizionari = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs FROM aprovizionari a JOIN produse p ON p.id = a.produs_id
         WHERE a.comanda_id = ? ORDER BY a.id DESC`
      )
      .all(comanda.id);

    // Fiecare mută bucata lui de drum: producția „în producție" și
    // „finalizat", depozitul stările de stoc și livrarea, financiarul
    // facturarea. Agentul nu are stările de livrare — el nu vede când pleacă
    // marfa din depozit, deci n-are de unde să știe; își poate anula doar
    // comanda lui. Lista e în lib/comenzi-stari.js.
    const stariDePus = stari.stariPermise(ctx.user, comanda);
    // Ștergerea e doar a adminului. Nu e un pas din flux — e ștergere
    // definitivă din bază, cu linii cu tot. Pentru „comanda nu se mai face"
    // există „anulată", care lasă urma pe client și motivul scris.
    const potiSterge = ctx.user && ctx.user.rol === "admin";

    // Răspunsul clientului la livrarea parțială. Îl poate schimba agentul
    // comenzii sau un admin — e o informație luată la telefon, nu o decizie
    // a depozitului, deci depozitul n-o rescrie.
    const acceptaPartial = livrare.acceptaPartial(comanda);
    const potiRaspundeLivrare =
      ctx.user && (ctx.user.rol === "admin" || Number(comanda.agent_id) === Number(ctx.user.id) || ctx.user.rol === "vanzari");
    const formLivrare = (etichetaButon) =>
      `<form method="post" action="/comenzi/${comanda.id}/livrare-partiala" class="inline-form" style="gap:6px;margin-top:6px">
         <select name="livrare_partiala">
           <option value="da"${livrare.raspuns(comanda) === "da" ? " selected" : ""}>acceptă livrare parțială</option>
           <option value="nu"${livrare.raspuns(comanda) === "nu" ? " selected" : ""}>doar comanda completă</option>
         </select>
         <button class="btn small" type="submit">${esc(etichetaButon)}</button>
       </form>`;

    const body = `
      ${baraStatus(comanda)}
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Client</div>${esc(comanda.partener_nume)}</div>
          <div><div class="k">Data</div>${esc(comanda.data)}</div>
          <div><div class="k">Status</div>${STATUS_LABEL[comanda.status] || esc(comanda.status)}</div>
          <div><div class="k">Moneda</div>${esc(comanda.moneda || "RON")}</div>
          <div><div class="k">Livrare parțială</div>${livrare.eticheta(comanda)}${
            potiRaspundeLivrare && comanda.status !== "anulata" && !comanda.factura_id
              ? formLivrare(livrare.raspuns(comanda) ? "Schimbă" : "Răspunde")
              : ""
          }</div>
          <div><div class="k">Observații</div>${esc(comanda.observatii) || "—"}</div>
        </div>
      </div>
      ${
        !livrare.raspuns(comanda) && comanda.status !== "anulata"
          ? `<p style="max-width:820px;color:var(--text-muted);font-size:13px;margin:0 0 12px">
               Comanda asta e de dinainte să întrebăm despre livrarea parțială. Până primește un răspuns,
               depozitul o tratează ca „doar comanda completă" — nu pleacă nimic pe jumătate din greșeală.
             </p>`
          : ""
      }

      ${table(
        ["Produs", "Cantitate", "UM", "Preț unitar", "Subtotal", "În stoc acum"],
        linii.map((l) => {
          const st = stocPeLinie.get(Number(l.id));
          const stocTxt = !st
            ? "—"
            : st.ramas <= 0.0001
              ? '<span class="badge verde">livrată</span>'
              : st.lipsa <= 0.0001
                ? '<span class="badge verde">tot pe stoc</span>'
                : st.acoperit > 0.0001
                  ? `<span class="badge galben">parțial ${st.acoperit.toLocaleString("ro-RO", { maximumFractionDigits: 3 })}</span>`
                  : '<span class="badge rosu">lipsă</span>';
          return [
            esc(l.denumire),
            l.cantitate,
            // Unitatea scrisă pe linie bate pe cea din nomenclator: acolo e
            // unitatea în care ținem produsul, aici cea în care s-a comandat.
            esc(l.um || l.unitate_masura),
            sumaIn(l.pret_unitar, comanda.moneda),
            sumaIn(l.cantitate * l.pret_unitar, comanda.moneda),
            stocTxt,
          ];
        })
      )}
      <div class="totals"><span class="grand">Total: ${esc(sumaIn(total, comanda.moneda))}</span></div>

      ${
        comanda.verificata_depozit_la
          ? `<div class="detail-box" style="margin-top:12px">
               <strong>Depozitul a verificat comanda</strong> la ${esc(String(comanda.verificata_depozit_la).slice(0, 16))}
               ${comanda.verificata_depozit_de ? " — " + esc(comanda.verificata_depozit_de) : ""}.
               ${stoc.acoperiteTot ? "Toată marfa e disponibilă." : stoc.acoperitePartial ? "O parte din marfă e disponibilă." : "Marfa nu e pe stoc."}
             </div>`
          : `<p style="color:var(--text-muted);font-size:13px;margin-top:12px">Comanda așteaptă verificarea depozitului.</p>`
      }
      ${
        rezervareActiva
          ? `<p class="badge galben">Stoc rezervat până la ${esc(String(rezervareActiva.rezervare.expira_la || "").slice(0, 16))} — după aceea se eliberează singur.</p>`
          : ""
      }
      ${
        aprovizionari.length
          ? `<h2>Aprovizionare cerută</h2>
             ${table(
               ["Produs", "Cantitate", "Sursă", "Termen cerut", "Termen confirmat", "Status"],
               aprovizionari.map((a) => [
                 esc(a.produs),
                 a.cantitate,
                 a.sursa === "productie" ? "producție" : "terț",
                 esc(a.termen_cerut || "—"),
                 esc(a.termen_confirmat || "—"),
                 esc(a.status),
               ])
             )}`
          : ""
      }

      ${
        comanda.status === "ciorna"
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:820px;margin-bottom:14px">
               <strong>Comandă citită dintr-un email.</strong>
               ${comanda.email_mesaj_id ? `<a href="/email/${comanda.email_mesaj_id}">Vezi mesajul</a> · ` : ""}
               Liniile de mai jos au fost ghicite din text — verifică-le, pune prețurile, și abia apoi validează.
               Până validezi tu, nu pleacă niciun email către birou sau depozit.
               <form method="post" action="/comenzi/${comanda.id}/valideaza" style="margin-top:10px"
                     onsubmit="return confirm('Comanda devine „nouă” și pleacă anunțul către birou și depozit. Continui?')">
                 <button class="btn" type="submit">Validează și trimite anunțul</button>
               </form>
             </div>`
          : ""
      }
      ${
        stoc.acoperitePartial && !comanda.factura_id && comanda.status !== "anulata"
          ? `<h2>Ce faci cu comanda</h2>
             <div class="toolbar" style="flex-wrap:wrap;gap:8px">
               ${
                 stoc.acoperiteTot
                   ? `<form method="post" action="/comenzi/${comanda.id}/factureaza" class="inline-form"><button class="btn" type="submit">Facturează tot</button></form>`
                   : acceptaPartial
                     ? `<form method="post" action="/comenzi/${comanda.id}/factureaza-partial" class="inline-form"><button class="btn" type="submit">Facturează parțial ce e în stoc</button></form>`
                     : `<span style="color:var(--text-muted);font-size:13px;max-width:460px">
                          ${livrare.raspuns(comanda) === "nu" ? "Clientul a cerut comanda completă" : "Nu știm dacă clientul acceptă parțial"} —
                          nu se facturează pe bucăți. Comanda așteaptă marfa, sau schimbi răspunsul mai sus.
                        </span>`
               }
               <form method="post" action="/comenzi/${comanda.id}/decizie" class="inline-form">
                 <input type="hidden" name="decizie" value="astept">
                 <button class="btn secondary" type="submit">Aștept comanda completă</button>
               </form>
               <form method="post" action="/depozit/comanda/${comanda.id}/rezerva" class="inline-form">
                 <input type="hidden" name="inapoi" value="crm">
                 <button class="btn secondary" type="submit">Rezervă stocul 24 h</button>
               </form>
               ${
                 rezervareActiva
                   ? `<form method="post" action="/depozit/comanda/${comanda.id}/elibereaza" class="inline-form">
                        <input type="hidden" name="inapoi" value="crm">
                        <button class="link-btn" type="submit">Renunț la rezervare</button>
                      </form>`
                   : ""
               }
             </div>
             ${comanda.decizie_agent === "astept" ? '<p style="color:var(--text-muted);font-size:13px">Ai ales să aștepți comanda completă.</p>' : ""}`
          : ""
      }

      <h2>Acțiuni</h2>
      ${
        stariDePus.length
          ? `<form method="post" action="/comenzi/${comanda.id}/status" class="form" style="max-width:360px">
              <label class="field"><span>Schimbă status</span>
                <select name="status">
                  ${stariDePus
                    .map((s) => `<option value="${s}" ${s === comanda.status ? "selected" : ""}>${esc(stari.PASI_ETICHETE[s] || s.replace(/_/g, " "))}</option>`)
                    .join("")}
                </select>
              </label>
              <button type="submit" class="btn small">Actualizează status</button>
              <div class="mic" style="color:var(--text-muted);margin-top:4px">Doar pașii care sunt ai tăi. Restul îi mută depozitul, producția sau facturarea.</div>
            </form>`
          : `<p style="color:var(--text-muted);font-size:13px;max-width:520px">
               Pe comanda asta n-ai pași de mutat. Depozitul o verifică pe stoc, producția o face, facturarea o închide —
               iar tu vei putea cere factura când ajunge „în stoc depozit".
             </p>`
      }

      <div class="toolbar" style="margin-top:14px">
        ${
          facturi.length
            ? facturi
                .map(
                  (f) =>
                    `<a href="/facturi/${f.id}" class="btn secondary">Factura ${esc(f.serie || "")}${esc(String(f.numar || f.id))}${String(f.status) === "ciorna" ? " (ciornă)" : ""}</a>`
                )
                .join(" ")
            : poateFactura(comanda)
              ? `<form method="post" action="/comenzi/${comanda.id}/factureaza" class="inline-form"><button type="submit" class="btn">Facturează</button></form>`
              : `<span style="color:var(--text-muted);font-size:13px">Facturarea se deblochează la statusul „în stoc depozit".</span>`
        }
        ${
          potiSterge
            ? `<form method="post" action="/comenzi/${comanda.id}/sterge" class="inline-form"
                     onsubmit="return confirm('Ștergi DEFINITIV comanda ${esc(String(comanda.numar || "#" + comanda.id)).replace(/'/g, "")}, cu tot cu linii? Nu se mai poate întoarce. Dacă vrei doar s-o oprești, pune-o pe „anulată”.')">
                 <button type="submit" class="link-btn danger">Șterge comanda</button>
               </form>`
            : ""
        }
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comandă ${comanda.numar || "#" + comanda.id}`, active: "/comenzi", body }));
  });

  // Validarea unei ciorne născute dintr-un email. O poate apăsa agentul comenzii
  // sau un administrator — nu depozitul, fiindcă nu el a vorbit cu clientul.
  router.post("/comenzi/:id/valideaza", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/comenzi");
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!c) return redirect(ctx.res, "/comenzi");
    if (c.status !== "ciorna") return redirect(ctx.res, `/comenzi/${c.id}`);
    const alLui = Number(c.agent_id) === Number(ctx.user.id);
    if (!alLui && ctx.user.rol !== "admin") return redirect(ctx.res, `/comenzi/${c.id}`);

    await db.prepare("UPDATE comenzi SET status = 'noua' WHERE id = ?").run(c.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: validată din ciornă`, "Citită dintr-un email și confirmată de agent.", ctx.user.id);
    try {
      await anuntaComandaNoua(c.id, ctx.user);
    } catch (e) {
      console.error("[comenzi] anunt dupa validare:", e.message);
    }
    redirect(ctx.res, `/comenzi/${c.id}`);
  });

  router.post("/comenzi/:id/status", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const nou = String(ctx.body.status || "");
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!c) return redirect(ctx.res, "/comenzi");
    // Lista se citește din comandă, nu doar din rol: agentul își mută doar
    // comanda lui. Verificarea e aici, nu doar în `<select>` — altfel un POST
    // trimis de mână ar putea pune orice stare pe orice comandă.
    if (!stari.poateMuta(ctx.user, c, nou)) return redirect(ctx.res, `/comenzi/${ctx.params.id}`);
    await db.prepare("UPDATE comenzi SET status = ? WHERE id = ?").run(nou, c.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: ${nou.replace(/_/g, " ")}`, null, ctx.user.id);
    redirect(ctx.res, `/comenzi/${ctx.params.id}`);
  });

  // „Facturează" — agentul poate apăsa DOAR după ce marfa e în stoc la
  // depozit. Nu emite nimic: naște o factură CIORNĂ, pe care o validează
  // apoi cineva cu drepturi pe facturare. Până la validare nu pleacă nimic
  // în SmartBill și nu se mișcă niciun stoc.
  router.post("/comenzi/:id/factureaza", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!comanda) return redirect(ctx.res, "/comenzi");

    if (comanda.factura_id) return redirect(ctx.res, `/facturi/${comanda.factura_id}`);

    if (!poateFactura(comanda)) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Încă nu se poate factura",
          active: "/comenzi",
          body: `<h1>Încă nu se poate factura</h1>
            <p style="max-width:620px">Comanda e în starea <strong>${esc(comanda.status)}</strong>.
              Factura se poate cere abia când marfa ajunge la starea
              <strong>în stoc depozit</strong> — până atunci n-ai ce livra.</p>
            <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const linii = await db
      .prepare(`SELECT cl.*, p.denumire, p.cota_tva FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`)
      .all(comanda.id);
    if (!linii.length) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Comandă fără linii",
          active: "/comenzi",
          body: `<h1>Comandă fără linii</h1><p>Nu pot factura o comandă goală.</p>
            <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const info = await db
      .prepare("INSERT INTO facturi (partener_id, comanda_id, directie, status, creata_de, agent_id, data_emiterii) VALUES (?, ?, 'vanzare', 'ciorna', ?, ?, ?) RETURNING id")
      .run(comanda.partener_id, comanda.id, ctx.user.id, comanda.agent_id || ctx.user.id, new Date().toISOString().slice(0, 10));
    const facturaId = info.lastInsertRowid;
    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of linii) {
      await insertLinie.run(facturaId, l.produs_id, l.denumire, l.cantitate, l.pret_unitar, l.cota_tva);
    }
    await db.prepare("UPDATE comenzi SET factura_id = ? WHERE id = ?").run(facturaId, comanda.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(comanda.partener_id, `Factură ciornă din comanda ${comanda.numar || "#" + comanda.id}`, "Așteaptă validare pe modulul de facturare.", ctx.user.id);

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  // Decizia agentului după ce depozitul i-a spus ce are: „aștept comanda
  // completă" nu face nimic în stoc, doar o scrie, ca să nu întrebe nimeni
  // peste trei zile de ce stă comanda.
  router.post("/comenzi/:id/decizie", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const decizie = String((ctx.body || {}).decizie || "").slice(0, 30);
    await db.prepare("UPDATE comenzi SET decizie_agent = ? WHERE id = ?").run(decizie || null, ctx.params.id);
    const c = await db.prepare("SELECT partener_id, numar, id FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (c) {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
        .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: ${decizie === "astept" ? "așteaptă comanda completă" : decizie}`, null, ctx.user.id);
    }
    redirect(ctx.res, `/comenzi/${ctx.params.id}`);
  });

  // Răspunsul la livrarea parțială, dat sau schimbat după plasare.
  //
  // Există pentru comenzile de dinainte de coloana asta și pentru cazul real
  // în care clientul se răzgândește la telefon. Nu-l dă depozitul: el vede
  // răspunsul, nu-l scrie — altfel „clientul acceptă" ar deveni ce-i convine
  // depozitului într-o zi aglomerată.
  //
  // Dacă răspunsul se schimbă în „da" iar comanda stătea pe „așteaptă marfă"
  // cu ceva disponibil, drumul se redeschide singur: trece pe „în stoc
  // depozit" și agentul poate factura partea acoperită. Invers, un „nu" pe o
  // comandă neacoperită integral o trimite înapoi la așteptare.
  router.post("/comenzi/:id/livrare-partiala", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!comanda) return redirect(ctx.res, "/comenzi");
    const potrivit =
      ctx.user.rol === "admin" || ctx.user.rol === "vanzari" || Number(comanda.agent_id) === Number(ctx.user.id);
    if (!potrivit) return redirect(ctx.res, `/comenzi/${comanda.id}`);

    const raspuns = livrare.valid((ctx.body || {}).livrare_partiala);
    if (!raspuns) return redirect(ctx.res, `/comenzi/${comanda.id}`);
    await db.prepare("UPDATE comenzi SET livrare_partiala = ? WHERE id = ?").run(raspuns, comanda.id);

    // Recalculăm starea doar dacă depozitul se uitase deja la stoc. Înainte de
    // verificare n-avem ce muta: comanda e tot „nouă" și așteaptă depozitul.
    if (comanda.verificata_depozit_la && ["asteapta_marfa", "in_stoc_depozit", "confirmata"].includes(comanda.status)) {
      try {
        const { acoperiteTot, acoperitePartial } = await require("./warehouse").potrivire(comanda.id);
        const nou = livrare.statusDupaVerificare({
          acoperiteTot,
          acoperitePartial,
          comanda: { ...comanda, livrare_partiala: raspuns },
        });
        if (nou !== comanda.status) await db.prepare("UPDATE comenzi SET status = ? WHERE id = ?").run(nou, comanda.id);
      } catch (e) {
        console.error("[comenzi] recalcul status dupa livrare partiala:", e.message);
      }
    }

    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(
        comanda.partener_id,
        `Comanda ${comanda.numar || "#" + comanda.id}: ${livrare.text({ livrare_partiala: raspuns })}`,
        null,
        ctx.user.id
      );
    redirect(ctx.res, `/comenzi/${comanda.id}`);
  });

  // Facturare parțială: intră pe factură doar cât e acoperit din stoc acum.
  // Restul rămâne pe comandă, cu „cantitate_livrata" mărită, ca a doua oară
  // să se factureze exact ce a mai rămas.
  router.post("/comenzi/:id/factureaza-partial", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!comanda) return redirect(ctx.res, "/comenzi");
    if (comanda.status === "anulata") return redirect(ctx.res, `/comenzi/${comanda.id}`);

    // Butonul nu se arată dacă clientul n-a acceptat parțial, dar asta e doar
    // HTML. Regula se ține aici: un POST trimis direct nu are voie să taie
    // comanda în bucăți pe care clientul nu le-a cerut.
    if (!livrare.acceptaPartial(comanda)) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Livrarea parțială nu e acceptată",
          active: "/comenzi",
          body: `<p style="max-width:620px">
                   ${
                     livrare.raspuns(comanda) === "nu"
                       ? "Clientul a cerut comanda completă, deci nu se facturează pe bucăți."
                       : "Nimeni n-a întrebat clientul dacă acceptă livrare parțială, iar fără răspuns nu pleacă marfă pe jumătate."
                   }
                 </p>
                 <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const { linii: potrivite } = await require("./warehouse").potrivire(comanda.id);
    const deFacturat = potrivite.filter((l) => l.acoperit > 0.0001);
    if (!deFacturat.length) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Nimic de facturat",
          active: "/comenzi",
          body: `<p style="max-width:620px">Nu e nimic disponibil pe stoc din comanda asta chiar acum.</p>
                 <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const info = await db
      .prepare(
        "INSERT INTO facturi (partener_id, comanda_id, directie, status, creata_de, agent_id, data_emiterii, observatii) VALUES (?, ?, 'vanzare', 'ciorna', ?, ?, ?, ?) RETURNING id"
      )
      .run(
        comanda.partener_id,
        comanda.id,
        ctx.user.id,
        comanda.agent_id || ctx.user.id,
        new Date().toISOString().slice(0, 10),
        "facturare parțială — restul comenzii rămâne deschis"
      );
    const facturaId = info.lastInsertRowid;
    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of deFacturat) {
      const cota = await db.prepare("SELECT cota_tva FROM produse WHERE id = ?").get(l.produs_id);
      await insertLinie.run(facturaId, l.produs_id, l.denumire, l.acoperit, l.pret_unitar, cota ? cota.cota_tva : 21);
      await db
        .prepare("UPDATE comenzi_linii SET cantitate_livrata = COALESCE(cantitate_livrata, 0) + ? WHERE id = ?")
        .run(l.acoperit, l.id);
    }
    // Rezervările comenzii se sting: marfa tocmai a plecat pe factură.
    await db.prepare("UPDATE rezervari_stoc SET stare = 'consumata' WHERE comanda_id = ? AND stare = 'activa'").run(comanda.id);

    const rest = await db
      .prepare("SELECT COALESCE(SUM(cantitate - COALESCE(cantitate_livrata, 0)), 0) AS r FROM comenzi_linii WHERE comanda_id = ?")
      .get(comanda.id);
    if (Number(rest.r || 0) <= 0.0001) {
      await db.prepare("UPDATE comenzi SET status = 'facturata', factura_id = ? WHERE id = ?").run(facturaId, comanda.id);
    } else {
      await db.prepare("UPDATE comenzi SET decizie_agent = 'facturat_partial' WHERE id = ?").run(comanda.id);
    }
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(
        comanda.partener_id,
        `Facturare parțială din comanda ${comanda.numar || "#" + comanda.id}`,
        "Factură ciornă, așteaptă validare. Restul comenzii rămâne deschis.",
        ctx.user.id
      );
    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  // Ștergerea unei comenzi — numai adminul.
  //
  // Ruta asta n-a avut NICIO verificare până acum. Butonul se ascundea de
  // cine n-avea voie, dar un POST trimis de mână ștergea definitiv orice
  // comandă, cu linii cu tot, de la orice utilizator logat. Ascunderea unui
  // buton nu e un drept de acces; se vedea abia când cineva nimerea adresa.
  //
  // Nu se șterge în tăcere: înainte de DELETE se scrie în istoricul
  // clientului ce comandă a fost și cine a șters-o. Rândul din `comenzi`
  // dispare, urma rămâne — altfel o comandă de 40.000 de lei se evaporă și
  // peste o lună nu mai știe nimeni că a existat.
  router.post("/comenzi/:id/sterge", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    if (ctx.user.rol !== "admin") return redirect(ctx.res, `/comenzi/${ctx.params.id}`);
    try {
      const c = await db
        .prepare(
          `SELECT c.*, COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
           FROM comenzi c WHERE c.id = ?`
        )
        .get(ctx.params.id);
      if (!c) return redirect(ctx.res, "/comenzi");
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
        .run(
          c.partener_id,
          `Comanda ${c.numar || "#" + c.id} a fost ștearsă`,
          `Ștearsă definitiv de ${ctx.user.nume}. Era pe statusul „${c.status}”, valoare ${Number(c.total || 0).toFixed(2)} lei.`,
          ctx.user.id
        );
      await db.prepare("DELETE FROM comenzi_linii WHERE comanda_id = ?").run(ctx.params.id);
      await db.prepare("DELETE FROM comenzi WHERE id = ?").run(ctx.params.id);
      redirect(ctx.res, "/comenzi");
    } catch (e) {
      if (e.code === "23503") {
        return send(
          ctx.res,
          409,
          layout({ user: ctx.user,
            title: "Nu se poate șterge",
            active: "/comenzi",
            body: `<p>Această comandă nu poate fi ștearsă pentru că are o factură generată din ea. Șterge mai întâi factura asociată.</p><a href="/comenzi/${ctx.params.id}" class="btn secondary">Înapoi la comandă</a>`,
          })
        );
      }
      throw e;
    }
  });
}

module.exports = { register, STATUS_LABEL };
