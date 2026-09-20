// Puntea pentru lista de clienți și furnizori — se rulează în consola
// tab-ului SmartBill al firmei de la care iei lista.
//
// De ce există: Warehouse All are cont SmartBill separat, deci nu se poate lua
// nimic „de la distanță" — nu avem cheie acolo și nici n-o vrem. Browserul are
// însă sesiunea deschisă, iar lista de clienți e chiar pe ecran. O citește și
// o trimite în ERP, unde așteaptă „Aplică" ca orice alt lot de punte.
//
// De ce citește tabelul generic, în loc să știe interfața SmartBill: pentru că
// interfața se schimbă, iar un script care știe pe de rost clasele CSS moare
// tăcut la prima actualizare. Ăsta caută tabelul cel mai mare de pe pagină și
// trimite exact ce scrie în capul lui. Potrivirea coloanelor se face în ERP,
// după denumire — acolo se și repară, dacă apare o denumire nouă.
//
// Cum se folosește:
//   1. în tab-ul SmartBill, pe lista de CLIENȚI (pune-o pe cât mai multe
//      rânduri pe pagină), în consolă:
//        fetch("https://erp-cashmachine-app.onrender.com/punte/parteneri.js").then(r=>r.text()).then(eval)
//   2. aduni pagina de pe ecran:
//        __parteneri.aduna("client")
//      treci la pagina următoare, aduni iar, până le termini. Rândurile
//      duplicate nu se strâng de două ori.
//   3. treci pe lista de FURNIZORI și aduni la fel:
//        __parteneri.aduna("furnizor")
//   4. vezi ce ai strâns:
//        __parteneri.cate()
//        __parteneri.uitaTe()      ← primele 5 rânduri, să verifici coloanele
//   5. trimiți:
//        await __parteneri.trimite()
//   6. în ERP: Import → Punte → lotul „Clienți și furnizori" → Aplică.
//
// Nimic nu intră în baza de date până nu apeși „Aplică" în ERP.

(function () {
  "use strict";

  const ERP = "https://erp-cashmachine-app.onrender.com";
  const LOT = 500; // câte rânduri într-o trimitere

  const strânse = [];
  const vazute = new Set();

  function text(el) {
    return String((el && el.innerText) || "").replace(/\s+/g, " ").trim();
  }

  // Tabelul care ne interesează: cel cu cele mai multe rânduri. Pe paginile
  // SmartBill mai există tabele mici de filtre sau de totaluri, iar „primul
  // tabel" ar fi nimerit des pe alea.
  function tabelul() {
    let cel = null;
    for (const t of document.querySelectorAll("table")) {
      const n = t.querySelectorAll("tr").length;
      if (n < 2) continue;
      if (!cel || n > cel.querySelectorAll("tr").length) cel = t;
    }
    return cel;
  }

  function capete(t) {
    // Capul de tabel poate fi în <thead> sau doar primul <tr> cu <th>.
    const th = t.querySelectorAll("thead th");
    if (th.length) return [...th].map(text);
    const primul = t.querySelector("tr");
    const celule = primul ? primul.querySelectorAll("th, td") : [];
    return [...celule].map(text);
  }

  function randuri(t) {
    const corp = t.querySelector("tbody") || t;
    const toate = [...corp.querySelectorAll("tr")];
    // Dacă n-a fost <thead>, primul rând era capul: se sare.
    return t.querySelector("thead") ? toate : toate.slice(1);
  }

  function cheie(o) {
    const c = Object.values(o).join("|").toLowerCase().replace(/\s+/g, " ").trim();
    return c;
  }

  function aduna(tip) {
    const fel = String(tip || "").toLowerCase() === "furnizor" ? "furnizor" : "client";
    const t = tabelul();
    if (!t) { console.warn("[punte] nu găsesc niciun tabel pe pagina asta"); return 0; }
    const cap = capete(t);
    if (!cap.length) { console.warn("[punte] tabelul n-are cap de coloane"); return 0; }

    let adaugate = 0;
    for (const tr of randuri(t)) {
      const celule = [...tr.querySelectorAll("td")];
      if (!celule.length) continue;
      const o = {};
      cap.forEach((nume, i) => {
        if (!nume) return;
        const v = text(celule[i]);
        if (v) o[nume] = v;
      });
      if (!Object.keys(o).length) continue;
      const k = fel + "|" + cheie(o);
      if (vazute.has(k)) continue;
      vazute.add(k);
      o.tip_partener = fel;
      strânse.push(o);
      adaugate++;
    }
    console.log(`[punte] am adunat ${adaugate} rânduri noi (${fel}). Total strâns: ${strânse.length}.`);
    console.log("[punte] coloane văzute:", cap.filter(Boolean).join(" | "));
    return adaugate;
  }

  function uitaTe(n) {
    const cate = Number(n) || 5;
    console.table(strânse.slice(0, cate));
    return strânse.slice(0, cate);
  }

  function cate() {
    const c = strânse.filter((x) => x.tip_partener === "client").length;
    const f = strânse.length - c;
    console.log(`[punte] ${strânse.length} rânduri: ${c} clienți, ${f} furnizori.`);
    return { total: strânse.length, clienti: c, furnizori: f };
  }

  function uita() {
    strânse.length = 0;
    vazute.clear();
    console.log("[punte] gata, am uitat tot. Poți lua de la capăt.");
  }

  async function trimite() {
    if (!strânse.length) { console.warn("[punte] n-ai adunat nimic încă. Rulează __parteneri.aduna(\"client\")."); return; }
    let trimis = 0;
    for (let i = 0; i < strânse.length; i += LOT) {
      const lot = strânse.slice(i, i + LOT);
      const r = await fetch(ERP + "/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tip: "parteneri", sursa: location.hostname + " — " + document.title, randuri: lot }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        console.error("[punte] lotul a fost refuzat:", j);
        return j;
      }
      trimis += lot.length;
      console.log(`[punte] trimis ${trimis} / ${strânse.length}`);
    }
    console.log("[punte] gata. Intră în ERP: Import → Punte, și apasă Aplică pe lotul „Clienți și furnizori”.");
    return { trimis };
  }

  window.__parteneri = { aduna, trimite, cate, uitaTe, uita, randuri: strânse };
  console.log("[punte] gata de lucru. Pașii: __parteneri.aduna(\"client\") → (pagina următoare, iar) → __parteneri.aduna(\"furnizor\") → __parteneri.cate() → await __parteneri.trimite()");
})();
