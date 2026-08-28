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
//   2. în tab-ul SmartBill: se lipește fișierul ăsta, apoi
//        window.__punte.incarcaCoada(lista.facturi)
//        window.__punte.porneste()
//   3. progresul:           window.__punte.stare()
//   4. oprire:              window.__punte.opreste()
//
// Bucla se conduce singură cu setTimeout: apelul de evaluare din CDP moare la
// 45 de secunde, dar bucla merge mai departe în pagină după ce apelul s-a
// întors. De-aia `porneste()` nu așteaptă nimic — pornește și pleacă.

(function () {
  "use strict";

  const ERP = "https://erp-cashmachine-app.onrender.com";
  const LOT = 60; // câte facturi se strâng înainte de o trimitere
  const PAUZA_MS = 400; // răgaz între facturi, ca să nu sufocăm SmartBill
  const ASTEPTARE_MAX_MS = 12000; // cât așteptăm randarea unei pagini

  // Adresa paginii unei facturi. Se verifică o dată, pe o factură reală, și
  // se corectează aici dacă SmartBill își schimbă rutele.
  const URL_FACTURA = (id) => `/factura/#/view/${id}`;

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
  function coloaneDinAntet(tabel) {
    const celule = [...tabel.querySelectorAll("thead th, thead td, tr:first-child th")].map((c) =>
      (c.innerText || c.textContent || "").trim().toLowerCase()
    );
    if (celule.length < 3) return null;
    const gaseste = (re) => celule.findIndex((t) => re.test(t));
    const cant = gaseste(/cantitate|\bcant\b|\bbuc\b(?!.*pre)/);
    const pret = gaseste(/pre[țt]\s*(unitar|\/|$)|pre[țt]\b/);
    const val = gaseste(/valoare|total\s*(f[ăa]r[ăa]|net)|\bvaloare\b/);
    if (cant < 0 || pret < 0 || val < 0 || cant === pret || pret === val || cant === val) return null;
    return { cant, pret, val };
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

  function culege(doc) {
    const tabele = [...doc.querySelectorAll("table")];
    let celMaiBun = null;

    for (const t of tabele) {
      const randuri = [...t.querySelectorAll("tr")]
        .map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.innerText || td.textContent || "").trim()))
        .filter((c) => c.length >= 3);
      if (randuri.length < 1) continue;
      const latime = Math.max(...randuri.map((r) => r.length));

      // 1. antetul, dacă e de încredere
      let comb = coloaneDinAntet(t);
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

    const linii = [];
    const probleme = [];
    for (const r of randuri) {
      const denumire = String(r[colDenumire] || "").trim();
      if (!denumire || /^total/i.test(denumire)) continue;
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
        linii.push({ denumire, cantitate: cant, pret_unitar: pret });
      } else if (!isNaN(val) && val !== 0) {
        linii.push({ denumire, cantitate: 1, pret_unitar: val, nepotrivit: true });
        probleme.push(denumire);
      } else if (!isNaN(pret) && pret !== 0) {
        linii.push({ denumire, cantitate: isNaN(cant) ? 1 : cant, pret_unitar: pret, nepotrivit: true });
        probleme.push(denumire);
      }
    }

    if (!linii.length) return { linii: [], motiv: "fara linii", probleme };
    return { linii, probleme };
  }

  // Deschide o factură într-un iframe ascuns și așteaptă să se randeze.
  function citeste(factura) {
    return new Promise((rezolva) => {
      const cadru = document.createElement("iframe");
      cadru.style.cssText = "position:fixed;left:-9999px;top:0;width:1200px;height:900px;opacity:0";
      cadru.src = URL_FACTURA(factura.id);
      let gata = false;
      const inchide = (rezultat) => {
        if (gata) return;
        gata = true;
        clearInterval(ceas);
        clearTimeout(limita);
        cadru.remove();
        rezolva(rezultat);
      };
      const limita = setTimeout(() => inchide({ linii: [], motiv: "incomplet" }), ASTEPTARE_MAX_MS);
      const ceas = setInterval(() => {
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
      }, 500);
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
    setTimeout(pas, PAUZA_MS);
  }

  S.incarcaCoada = function (facturi) {
    const deja = new Set(Object.keys(S.facute));
    S.coada = (facturi || []).filter((f) => f && f.id && !deja.has(f.cheie));
    return S.coada.length;
  };
  S.porneste = function () {
    if (S.ruleaza) return "merge deja";
    S.ruleaza = true;
    setTimeout(pas, 0);
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
