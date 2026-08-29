// Puntea pentru liniile de factură — se rulează în consola tab-ului SmartBill.
//
// De ce trăiește codul ăsta în repo și nu doar în capul meu: prima oară l-am
// scris direct în pagină, iar când tab-ul s-a navigat din greșeală s-a pierdut
// cu totul — cu tot cu coada de lucru. Acum e un fișier: se citește, se
// corectează, se lipește din nou.
//
// Ce face: pentru fiecare factură din coadă deschide pagina ei într-un iframe
// ascuns (același origin, deci se poate citi), așteaptă ca Angular să termine
// de randat, culege liniile și le trimite în loturi la ERP, pe /api/ingest.
// În ERP loturile așteaptă „aplică" — nimic nu intră automat în baza de date.
//
// Cum se folosește:
//   1. în tab-ul ERP:      copy(await (await fetch('/api/facturi-fara-linii?an=2026')).json())
//      → de acolo iese lista de facturi care încă n-au linii
//   2. în tab-ul SmartBill, pe /raport/facturi/, cu perioada pusă pe anul
//      care te interesează: se lipește fișierul ăsta, apoi
//        await window.__punte.culegeHarta()   ← număr document → id SmartBill
//        window.__punte.incarcaCoada(lista.facturi)
//        window.__punte.porneste()
//   3. progresul:           window.__punte.stare()
//   4. oprire:              window.__punte.opreste()
//
// Bucla se conduce singură: apelul de evaluare din CDP moare la 45 de secunde,
// dar bucla merge mai departe în pagină după ce apelul s-a întors. De-aia
// `porneste()` nu așteaptă nimic — pornește și pleacă. Bătaia vine dintr-un
// Worker, nu din setTimeout, fiindcă filele din fundal au timerele strangulate
// la o bătaie pe minut și puntea ar părea înghețată.

(function () {
  "use strict";

  const ERP = "https://erp-cashmachine-app.onrender.com";
  const LOT = 60; // câte facturi se strâng înainte de o trimitere
  const PAUZA_MS = 400; // răgaz între facturi, ca să nu sufocăm SmartBill
  const ASTEPTARE_MAX_MS = 12000; // cât așteptăm randarea unei pagini

  // Adresa paginii unei facturi. Atenție, aici s-a pierdut o rundă întreagă:
  // id-ul din adresă e al lui SmartBill (nouă cifre, ex. 307103155), NU id-ul
  // facturii din ERP. Lista din `/api/facturi-fara-linii` dă id-uri de ERP,
  // deci trebuie trecută prin harta culeasă din raport — altfel fiecare
  // factură dă 404, iar puntea raportează liniștită „incomplet" la toate.
  const URL_FACTURA = (id) => `/raport/factura/${id}/`;

  const S = (window.__punte = window.__punte || {});
  S.coada = S.coada || [];
  S.facute = S.facute || {};
  S.esuate = S.esuate || [];
  S.linii = S.linii || [];
  S.trimise = S.trimise || 0;
  S.ruleaza = false;

  // „12,50" e un număr. „Folie 23 microni" nu e, chiar dacă are cifre în el.
  // Distincția asta contează: fără ea, coloana de denumire e confundată cu una
  // numerică și ajungi să scrii „rola" în loc de numele produsului.
  const ESTE_NUMAR = /^-?\s*[0-9][0-9.,\s]*%?$/;
  const esteNumar = (v) => ESTE_NUMAR.test(String(v === null || v === undefined ? "" : v).trim());

  const numar = (v) => {
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim().replace(/\s/g, "").replace(/[^0-9,.\-]/g, "");
    if (!s) return NaN;
    if (s.includes(",") && s.includes(".")) {
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (s.includes(",")) s = s.replace(",", ".");
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  };
  // numărul unei celule, dar doar dacă celula chiar e un număr
  const cell = (v) => (esteNumar(v) ? numar(v) : NaN);

  // Culege liniile dintr-un document randat.
  //
  // Nu ne legăm de clasele SmartBill — se schimbă. Ne legăm de două lucruri
  // care nu se schimbă: antetul, care își spune pe nume („Cantitate", „Preț",
  // „Valoare"), și aritmetica, pentru când antetul lipsește sau minte. Într-un
  // tabel de linii de factură există trei coloane pentru care
  // cantitate × preț ≈ valoare; tabelul cu cele mai multe rânduri care
  // respectă relația e tabelul de linii.
  //
  // Înmulțirea e comutativă, deci aritmetica singură nu poate spune care
  // factor e cantitatea și care e prețul. De-aia antetul are ultimul cuvânt,
  // iar când lipsește ne uităm la formă: cantitățile sunt mai des întregi,
  // prețurile au zecimale.
  function coloaneDinAntet(celuleAntet) {
    const celule = (celuleAntet || []).map((t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " "));
    if (celule.length < 3) return null;
    const gaseste = (re) => celule.findIndex((t) => re.test(t));
    const cant = gaseste(/cantitate|\bcant\b|\bbuc\b(?!.*pre)/);
    const pret = gaseste(/pre[țt]\s*(unitar|\/|$)|pre[țt]\b/);
    // „Valoare" da, „Valoare TVA" nu: pe factura clasica romaneasca sunt doua
    // coloane lipite, iar TVA-ul nu e valoarea liniei.
    const val = celule.findIndex((t) => /valoare|total\s*(f[ăa]r[ăa]|net)/.test(t) && !/tva/.test(t));
    if (cant < 0 || pret < 0 || val < 0 || cant === pret || pret === val || cant === val) return null;
    return { cant, pret, val };
  }

  // Randul de legenda al facturii clasice romanesti: „0 | 1 | 2 | 3 | 4 | 5 (3x4) | 6".
  // Sunt numere de coloana, nu date — dar respecta si aritmetica (2 x 3 = 6),
  // asa ca daca il lasam inauntru trage cautarea pe coloanele gresite.
  function eRandDeLegenda(r) {
    const pline = r.filter((c) => String(c || "").trim() !== "");
    if (pline.length < 3) return false;
    return pline.every((c) => /^\d{1,2}(\s*\(\s*\d+\s*[x×]\s*\d+\s*\))?$/.test(String(c).trim()));
  }

  function verifica(randuri, comb) {
    let n = 0;
    for (const r of randuri) {
      const x = cell(r[comb.cant]), y = cell(r[comb.pret]), z = cell(r[comb.val]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
      if (Math.abs(x * y - z) <= Math.max(0.05, Math.abs(z) * 0.01)) n++;
    }
    return n;
  }

  // De unde luăm rândurile.
  //
  // Factura SmartBill nu e un <table>: e randată cu divuri poziționate absolut
  // (șablonul Jasper), fiecare linie fiind un div cu clasa „style_tabel_color"
  // și cu câte un copil per celulă. De-aia căutăm întâi așa, și abia apoi
  // tabele adevărate — ca să meargă și pe alte pagini, dacă apar.
  function grupuriDeRanduri(doc) {
    const grupuri = [];
    const linii = [...doc.querySelectorAll('div[class*="style_tabel_color"]')]
      .map((r) => [...r.children].map((c) => (c.innerText || c.textContent || "").trim()))
      .filter((c) => c.length >= 3);
    if (linii.length) grupuri.push({ randuri: linii, antet: null });
    for (const t of doc.querySelectorAll("table")) {
      const toate = [...t.querySelectorAll("tr")]
        .map((tr) => [...tr.querySelectorAll("td, th")].map((td) => (td.innerText || td.textContent || "").trim()))
        .filter((c) => c.length >= 3);
      if (!toate.length) continue;
      // primul rand e antet daca isi spune pe nume; randul de legenda se arunca
      const antet = /cant|pre[țt]|valoare|denumire/i.test(toate[0].join(" ")) ? toate[0] : null;
      const randuri = toate.filter((r, i) => !(antet && i === 0) && !eRandDeLegenda(r));
      if (randuri.length) grupuri.push({ randuri, antet });
    }
    return grupuri;
  }

  function culege(doc) {
    let celMaiBun = null;

    for (const { randuri, antet } of grupuriDeRanduri(doc)) {
      const latime = Math.max(...randuri.map((r) => r.length));

      // 1. antetul, dacă există și e de încredere
      let comb = coloaneDinAntet(antet);
      let potriviri = comb ? verifica(randuri, comb) : 0;

      // 2. altfel (sau dacă antetul nu se confirmă aritmetic), căutăm tripleta
      if (!potriviri) {
        comb = null;
        for (let a = 0; a < latime; a++) {
          for (let b = a + 1; b < latime; b++) {
            for (let c = 0; c < latime; c++) {
              if (c === a || c === b) continue;
              const n = verifica(randuri, { cant: a, pret: b, val: c });
              if (n > potriviri) {
                // care din a și b e cantitatea: cea cu mai multe valori întregi
                const intregi = (col) => randuri.filter((r) => { const x = cell(r[col]); return !isNaN(x) && Math.abs(x % 1) < 1e-9; }).length;
                const [cant, pret] = intregi(a) >= intregi(b) ? [a, b] : [b, a];
                potriviri = n;
                comb = { cant, pret, val: c };
              }
            }
          }
        }
      }
      if (!comb || !potriviri) continue;
      if (!celMaiBun || potriviri > celMaiBun.potriviri) celMaiBun = { randuri, comb, potriviri, latime };
    }

    if (!celMaiBun) return { linii: [], motiv: "fara linii" };

    const { randuri, comb, latime } = celMaiBun;
    // denumirea: coloana cu cel mai mult TEXT (nu doar cifre) dintre cele
    // rămase după ce am scos cele trei coloane numerice
    let colDenumire = 0;
    let scorMax = -1;
    for (let i = 0; i < latime; i++) {
      if (i === comb.cant || i === comb.pret || i === comb.val) continue;
      const scor = randuri.reduce((s, r) => s + (esteNumar(r[i]) ? 0 : String(r[i] || "").length), 0);
      if (scor > scorMax) { scorMax = scor; colDenumire = i; }
    }

    // Denumirea vine din pagina cu tot cu codul produsului in fata, in forma
    // (sac1000) Sac transparent..., si cu descrierea pe randurile urmatoare.
    // Rupem codul, ca ERP-ul sa poata lega linia de produs, si stoarcem numele
    // intr-un singur rand.
    function despartitCod(brut) {
      const intreg = String(brut || "").replace(/\s+/g, " ").trim();
      const m = intreg.match(/^\(([^)]{1,40})\)\s*(.+)$/);
      if (m) return { cod: m[1].trim(), denumire: m[2].trim() };
      return { cod: "", denumire: intreg };
    }

    const linii = [];
    const probleme = [];
    for (const r of randuri) {
      const brut = String(r[colDenumire] || "").trim();
      if (!brut || /^total/i.test(brut)) continue;
      const desp = despartitCod(brut);
      const cod = desp.cod;
      const denumire = desp.denumire;
      const cant = cell(r[comb.cant]);
      const pret = cell(r[comb.pret]);
      const val = cell(r[comb.val]);
      if (isNaN(cant) && isNaN(pret) && isNaN(val)) continue;

      const iese = !isNaN(cant) && !isNaN(pret) && !isNaN(val) && Math.abs(cant * pret - val) <= Math.max(0.05, Math.abs(val) * 0.01);

      // Aici e lecția rundei trecute: liniile care nu ies la socoteală NU se
      // aruncă. Taxa de mediu e un procent, deșeul de ambalaj are cantitate
      // negativă — sunt linii reale de factură, doar că nu respectă
      // cantitate × preț = valoare. Le păstrăm cu valoarea declarată și
      // cantitatea 1, și notăm de ce.
      if (iese) {
        linii.push({ cod, denumire, cantitate: cant, pret_unitar: pret });
      } else if (!isNaN(val) && val !== 0) {
        linii.push({ cod, denumire, cantitate: 1, pret_unitar: val, nepotrivit: true });
        probleme.push(denumire);
      } else if (!isNaN(pret) && pret !== 0) {
        linii.push({ cod, denumire, cantitate: isNaN(cant) ? 1 : cant, pret_unitar: pret, nepotrivit: true });
        probleme.push(denumire);
      }
    }

    if (!linii.length) return { linii: [], motiv: "fara linii", probleme };
    return { linii, probleme };
  }

  // Chrome strangulează setTimeout/setInterval în filele din fundal: un timer
  // de 500 ms ajunge să bată o dată pe minut, iar puntea pare că a înghețat.
  // Un Worker nu e strangulat, așa că îi cerem lui bătaia și ținem noi
  // socoteala termenelor. Așa merge la fel de repede și cu fila în spate.
  const CEAS = (function () {
    const asteapta = [];
    let urmatorId = 1;
    const bate = () => {
      const acum = Date.now();
      for (const t of asteapta.slice()) {
        if (t.scadent > acum) continue;
        if (t.repeta) t.scadent = acum + t.ms;
        else asteapta.splice(asteapta.indexOf(t), 1);
        try {
          t.fn();
        } catch (e) {
          console.warn("[punte] ceas:", e);
        }
      }
    };
    let lucrator = null;
    try {
      const sursa = "let i=setInterval(()=>postMessage(0),200);onmessage=()=>clearInterval(i)";
      lucrator = new Worker(URL.createObjectURL(new Blob([sursa], { type: "text/javascript" })));
      lucrator.onmessage = bate;
    } catch (e) {
      // fără Worker (politici stricte) rămânem pe timerul obișnuit
      setInterval(bate, 200);
    }
    return {
      dupa(ms, fn) {
        const t = { id: urmatorId++, scadent: Date.now() + ms, ms, fn, repeta: false };
        asteapta.push(t);
        return t.id;
      },
      fiecare(ms, fn) {
        const t = { id: urmatorId++, scadent: Date.now() + ms, ms, fn, repeta: true };
        asteapta.push(t);
        return t.id;
      },
      opreste(id) {
        const i = asteapta.findIndex((t) => t.id === id);
        if (i >= 0) asteapta.splice(i, 1);
      },
      opresteTot() {
        asteapta.length = 0;
        if (lucrator) lucrator.postMessage(0);
      },
    };
  })();

  // Deschide o factură într-un iframe ascuns și așteaptă să se randeze.
  function citeste(factura) {
    return new Promise((rezolva) => {
      const cadru = document.createElement("iframe");
      // Iframe-ul trebuie să fie PE ECRAN, nu tras la -9999px: browserul nu
      // randează cadrele scoase din vizor, iar pagina rămâne la „loading" la
      // nesfârșit. Aici e în ecran, dar în spate și aproape transparent.
      cadru.style.cssText = "position:fixed;left:0;top:0;width:1100px;height:800px;opacity:0.01;z-index:-1;pointer-events:none";
      cadru.src = URL_FACTURA(factura.id);
      let gata = false;
      const inchide = (rezultat) => {
        if (gata) return;
        gata = true;
        CEAS.opreste(ceas);
        CEAS.opreste(limita);
        cadru.remove();
        rezolva(rezultat);
      };
      const limita = CEAS.dupa(ASTEPTARE_MAX_MS, () => inchide({ linii: [], motiv: "incomplet" }));
      const ceas = CEAS.fiecare(400, () => {
        let doc;
        try {
          doc = cadru.contentDocument;
        } catch (e) {
          return inchide({ linii: [], motiv: "alt origin" });
        }
        if (!doc || doc.readyState !== "complete") return;
        const r = culege(doc);
        // așteptăm până apar linii; dacă nu apar deloc, limita de timp taie
        if (r.linii.length) inchide(r);
      });
      document.body.appendChild(cadru);
    });
  }

  async function trimite() {
    if (!S.linii.length) return null;
    const lot = S.linii.splice(0, S.linii.length);
    try {
      const r = await fetch(ERP + "/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tip: "facturi_linii", randuri: lot, sursa: "punte SmartBill" }),
      });
      const corp = await r.text();
      S.trimise += lot.length;
      return { status: r.status, corp: corp.slice(0, 200) };
    } catch (e) {
      // dacă trimiterea pică, punem rândurile înapoi — nu se pierd
      S.linii = lot.concat(S.linii);
      return { eroare: String(e && e.message) };
    }
  }

  async function pas() {
    if (!S.ruleaza) return;
    const f = S.coada.shift();
    if (!f) {
      await trimite();
      S.ruleaza = false;
      console.log("[punte] gata", S.stare());
      return;
    }
    try {
      const r = await citeste(f);
      if (r.linii.length) {
        for (const l of r.linii) S.linii.push({ factura: f.cheie, ...l });
        S.facute[f.cheie] = r.linii.length;
        if (r.probleme && r.probleme.length) S.esuate.push({ cheie: f.cheie, motiv: "linii nepotrivite", probleme: r.probleme });
      } else {
        S.esuate.push({ cheie: f.cheie, id: f.id, motiv: r.motiv || "fara linii" });
      }
    } catch (e) {
      S.esuate.push({ cheie: f.cheie, id: f.id, motiv: "eroare: " + String(e && e.message) });
    }

    if (Object.keys(S.facute).length % LOT === 0 && S.linii.length) await trimite();
    CEAS.dupa(PAUZA_MS, pas);
  }

  // Harta „număr document → id SmartBill", culeasă din raportul de facturi.
  //
  // Se rulează O DATĂ, cu /raport/facturi/ deschis și cu perioada pusă pe anul
  // care te interesează. Umblă singură prin paginile grilei și adună perechile;
  // nu trimite nimic nicăieri și nu schimbă nimic în SmartBill.
  S.harta = S.harta || {};
  S.culegeHarta = async function (pagini) {
    const strange = () => {
      let n = 0;
      for (const tr of document.querySelectorAll("tbody tr")) {
        const a = tr.querySelector('a[href*="/raport/factura/"]');
        if (!a) continue;
        const m = a.getAttribute("href").match(/\/raport\/factura\/(\d+)\//);
        if (!m) continue;
        const cheie = (tr.innerText || "").trim().split(/\s+/)[0];
        if (!cheie || !/^[A-Z]/.test(cheie)) continue;
        if (!S.harta[cheie]) { S.harta[cheie] = Number(m[1]); n++; }
      }
      return n;
    };
    strange();
    const pag = document.querySelector(".dataTables_paginate");
    if (!pag) return Object.keys(S.harta).length;
    const urmatorul = () =>
      [...pag.querySelectorAll("span, div, a")].find(
        (e) => /(^|\s)next(\s|$)/.test(String(e.className)) && !/disabled/.test(String(e.className))
      );
    for (let i = 0; i < (pagini || 40); i++) {
      const n = urmatorul();
      if (!n) break;
      n.click();
      await new Promise((r) => setTimeout(r, 3500));
      strange();
    }
    return Object.keys(S.harta).length;
  };

  // Coada primește lista din ERP („id" = id de ERP) și o traduce prin hartă.
  // Ce nu se găsește în hartă NU se pune în coadă — altfel ar fi 404 mut.
  S.incarcaCoada = function (facturi) {
    const deja = new Set(Object.keys(S.facute));
    const areHarta = Object.keys(S.harta).length > 0;
    S.fara_harta = [];
    S.coada = [];
    for (const f of facturi || []) {
      if (!f || !f.cheie || deja.has(f.cheie)) continue;
      const sb = areHarta ? S.harta[f.cheie] : f.id;
      if (!sb) { S.fara_harta.push(f.cheie); continue; }
      S.coada.push({ id: sb, cheie: f.cheie });
    }
    return S.coada.length;
  };
  S.porneste = function () {
    if (S.ruleaza) return "merge deja";
    S.ruleaza = true;
    CEAS.dupa(0, pas);
    return "pornit, " + S.coada.length + " în coadă";
  };
  S.opreste = function () {
    S.ruleaza = false;
    return "oprit";
  };
  S.trimiteAcum = trimite;
  S.stare = function () {
    const motive = {};
    for (const e of S.esuate) motive[e.motiv] = (motive[e.motiv] || 0) + 1;
    return {
      facute: Object.keys(S.facute).length,
      in_harta: Object.keys(S.harta).length,
      fara_harta: (S.fara_harta || []).length,
      ramase: S.coada.length,
      netrimise: S.linii.length,
      trimise: S.trimise,
      esuate: S.esuate.length,
      motive,
      ruleaza: S.ruleaza,
    };
  };

  console.log("[punte] încărcată. incarcaCoada(lista) → porneste() → stare()");
})();
