// Sincronizarea zilnică din SmartBill — facturi noi, încasări, producție și costuri.
//
// Se rulează într-o filă deschisă pe cloud.smartbill.ro, logată. Nu cere
// parole și nu ține minte nimic: citește rapoartele pe care le vede omul
// logat și trimite rândurile în ERP, la /api/ingest, unde stau în așteptare
// până le aprobă administratorul din /import/punte.
//
// De ce iframe-uri și nu cereri directe: unele rapoarte din SmartBill își
// consumă token-ul CSRF la prima folosire, deci o cerere refăcută de noi e
// respinsă. Singurul mod sigur e să lăsăm pagina raportului să-și facă
// singură cererea, iar noi doar îi rescriem perioada înainte să plece.
//
// Cum se folosește:
//   fetch("https://erp-cashmachine-app.onrender.com/punte/sincronizare.js").then(r=>r.text()).then(eval)
//   await window.__sync.tot(14)      // ultimele 14 zile
//   window.__sync.stare()

(function () {
  "use strict";

  const ERP = "https://erp-cashmachine-app.onrender.com";
  const S = (window.__sync = window.__sync || {});
  S.jurnal = [];

  const log = (mesaj, date) => {
    const linie = { la: new Date().toISOString().slice(11, 19), mesaj, ...(date || {}) };
    S.jurnal.push(linie);
    console.log("[sync]", mesaj, date || "");
    return linie;
  };

  const doarZi = (d) => {
    const p = String(d || "").trim().split("/");
    return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : String(d || "").slice(0, 10);
  };
  const ddmmyyyy = (dt) =>
    `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
  const acumMinus = (zile) => ddmmyyyy(new Date(Date.now() - zile * 86400000));
  const aziText = () => ddmmyyyy(new Date());

  // Firma pe care e logată sesiunea. Contează: ERP-ul ține facturile pe firmă,
  // iar dacă cineva comută compania în SmartBill vrem să se vadă în lot, nu să
  // aterizeze marfa pe firma greșită.
  S.firma = function () {
    const t = document.body ? document.body.innerText : "";
    const m = t.match(/CASH MACHINE[^\n]{0,12}|WAREHOUSE ALL[^\n]{0,6}|MARINE BRANDING[^\n]{0,6}|YACHTMAG[^\n]{0,6}|SET ?SAIL[^\n]{0,12}/i);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  };

  function asteapta(conditie, mesajEroare, maxMs) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      (function bate() {
        let v = null;
        try {
          v = conditie();
        } catch (e) {
          v = null;
        }
        if (v) return res(v);
        if (Date.now() - t0 > (maxMs || 25000)) return rej(new Error(mesajEroare));
        setTimeout(bate, 250);
      })();
    });
  }

  // Deschide raportul într-un iframe ascuns, îi rescrie filtrul și îi întoarce
  // răspunsul JSON. `declanseaza` primește documentul iframe-ului și apasă
  // butonul care cere din nou datele.
  async function raport(cale, potrivesteUrl, filtru, declanseaza) {
    const cadru = document.createElement("iframe");
    cadru.style.cssText = "position:fixed;left:-9999px;top:0;width:1200px;height:800px;opacity:0";
    cadru.src = cale;
    document.body.appendChild(cadru);
    try {
      const w = await asteapta(
        () => (cadru.contentWindow && cadru.contentDocument && cadru.contentDocument.readyState === "complete" ? cadru.contentWindow : null),
        `Raportul ${cale} nu s-a încărcat.`,
        30000
      );
      const buton = await asteapta(() => declanseaza(cadru.contentDocument), `Nu am găsit butonul de reîmprospătare în ${cale}.`, 30000);

      let raspuns = null;
      const os = w.XMLHttpRequest.prototype.send;
      const oo = w.XMLHttpRequest.prototype.open;
      w.XMLHttpRequest.prototype.open = function (m, u) {
        this.__u = u;
        return oo.apply(this, arguments);
      };
      w.XMLHttpRequest.prototype.send = function (b) {
        if (potrivesteUrl.test(String(this.__u || ""))) {
          try {
            const p = new URLSearchParams(b);
            for (const [k, v] of Object.entries(filtru)) p.set(k, v);
            b = p.toString();
          } catch (e) {
            /* raport cu alt format de corp: îl lăsăm cum e */
          }
          this.addEventListener("load", () => {
            raspuns = this.responseText;
          });
        }
        return os.call(this, b);
      };

      buton.click();
      await asteapta(() => raspuns, `Raportul ${cale} n-a răspuns în timp util.`, 45000);
      return JSON.parse(raspuns);
    } finally {
      cadru.remove();
    }
  }

  async function trimite(tip, randuri, sursa) {
    if (!randuri.length) return log(`${tip}: nimic de trimis`, { randuri: 0 });
    const r = await fetch(ERP + "/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tip, sursa, randuri }),
    });
    const t = await r.text();
    let lot = null;
    try {
      lot = JSON.parse(t).lot;
    } catch (e) {
      /* răspuns neașteptat: îl punem în jurnal ca text */
    }
    return log(`${tip}: trimis`, { randuri: randuri.length, lot, raspuns: lot ? undefined : t.slice(0, 200) });
  }

  const apasa = (text) => (doc) =>
    doc.querySelector("#change_iDisplayLength") ||
    [...doc.querySelectorAll("a,button")].find((e) => (e.innerText || "").trim() === (text || "Aplica"));

  // ---- facturi emise ------------------------------------------------------
  S.facturi = async function (zile) {
    const j = await raport(
      "/raport/facturi/",
      /\/raport\/facturi\/ajax/,
      { sSearch: JSON.stringify({ from: acumMinus(zile), to: aziText(), currency: "0" }), iDisplayStart: "0", iDisplayLength: "2000" },
      apasa()
    );
    const firma = S.firma();
    const randuri = (j.aaData || []).map((r) => ({
      document: String(r[2] || "").trim(),
      client: r[3],
      data: doarZi(r[4]),
      scadenta: doarZi(r[5]),
      net: r[6],
      tva: r[7],
      total: r[8],
      moneda: r[9],
      status: String(r[13]) === "True" ? "anulata" : String(r[14]) === "True" ? "ciorna" : "emisa",
      firma,
    }));
    await trimite("facturi", randuri, `sincronizare ${firma} — facturi ${zile} zile`);
    return randuri.length;
  };

  // ---- încasări -----------------------------------------------------------
  S.incasari = async function (zile) {
    const j = await raport(
      "/raport/incasari/",
      /\/raport\/incasari\/ajax/,
      { sSearch: JSON.stringify({ from: acumMinus(zile), to: aziText(), currency: "0" }), iDisplayStart: "0", iDisplayLength: "2000" },
      apasa()
    );
    const firma = S.firma();
    const randuri = [];
    for (const r of j.aaData || []) {
      const anulata = String(r[11]) === "True";
      if (anulata) continue;
      const facturi = Array.isArray(r[4])
        ? r[4].map((f) => `${f.document_series_name || ""}${f.document_number || ""}`).filter(Boolean)
        : String(r[4] || "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
      if (!facturi.length) continue;
      randuri.push({ factura: facturi.join(", "), data: doarZi(r[5]), suma: r[6], moneda: r[7], metoda: r[1], client: r[3] });
    }
    await trimite("incasari", randuri, `sincronizare ${firma} — încasări ${zile} zile`);
    return randuri.length;
  };

  // ---- costuri de achiziție, din balanța stocului -------------------------
  S.costuri = async function (deLaAn) {
    const an = deLaAn || new Date().getFullYear() - 2;
    const j = await raport(
      "/gestiune/raport/balanta_stocului/",
      /balanta_stocului\/ajax/,
      {
        sSearch: JSON.stringify({
          product_list: [], product_name: "", product_code: "", warehouse: "-1",
          from: `01/01/${an}`, to: aziText(), measuring_unit: -1, document_types: [], document_series: [],
          show_unit_price: true, show_product_totals: true,
          hide_no_stock_and_transactions: false, hide_no_transactions: false, hide_no_stock: false,
          page: 1, results_per_page: 3000,
        }),
      },
      apasa()
    );
    const randuri = [];
    for (const w of j.warehouses || []) {
      for (const p of w.products || []) {
        randuri.push({
          cod: p.productCode || "",
          denumire: String(p.productName || "").replace(/^\s*\d+\s*-\s*/, "").trim(),
          cantitate_intrari: p.productQuantityIn, valoare_intrari: p.productValueIn,
          cantitate_iesiri: p.productQuantityOut, valoare_iesiri: p.productValueOut,
          cantitate_stoc: p.productQuantityAfterOperations, valoare_stoc: p.productTotalValueAfterOperations,
        });
      }
    }
    await trimite("cost_produse", randuri, `sincronizare ${S.firma()} — costuri din balanța stocului`);
    return randuri.length;
  };

  // ---- producție (rețete) -------------------------------------------------
  // Raportul de mișcări ne dă, document cu document, ce a intrat și ce a ieșit
  // din gestiune. Un raport de producție are ambele: produsul finit intră,
  // componentele ies. Din raportul lunii se reconstruiește rețeta — de aceea
  // se trimite tot ce s-a mișcat, iar ERP-ul calculează cât intră pe bucată.
  const CSRF = () =>
    (document.querySelector("input[name=csrfmiddlewaretoken]") || {}).value ||
    (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] ||
    "";

  async function miscari(de, la, pagina) {
    const s = {
      product_list: [], product_name: "", product_code: "", warehouse: "-1",
      from: de, to: la, measuring_unit: -1, document_types: [], document_series: [],
      show_unit_price: true, show_product_totals: false,
      hide_no_stock_and_transactions: true, hide_no_transactions: true, hide_no_stock: false,
      page: pagina, results_per_page: 200,
    };
    const r = await fetch("/gestiune/raport/miscari_stocuri/ajax/", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRFToken": CSRF(),
      },
      body: "sSearch=" + encodeURIComponent(JSON.stringify(s)),
    });
    return r.json();
  }

  // documente care sigur nu sunt producție, chiar dacă au și intrări și ieșiri
  const NU_E_PRODUCTIE = /transfer|inventar|recep|aviz|factur|retur|dezmembr|stoc initial|stoc inițial/i;
  const E_PRODUCTIE = /produc|predare/i;

  S.productie = async function (zile) {
    const de = acumMinus(zile);
    const la = aziText();
    const documente = new Map();
    let total = Infinity;
    let vazute = 0;
    for (let pagina = 1; pagina <= 30 && vazute < total; pagina++) {
      const j = await miscari(de, la, pagina);
      if (j && j.csrf_fails) throw new Error("SmartBill a refuzat cererea (CSRF). Reîncarcă pagina și încearcă din nou.");
      const info = String((j && j.info) || "");
      const m = info.match(/din\s+(\d+)/);
      if (m) total = Number(m[1]);
      let peAceastaPagina = 0;
      for (const w of (j && j.warehouses) || []) {
        for (const p of w.products || []) {
          peAceastaPagina++;
          const denumire = String(p.productName || "").replace(/^\s*\d+\s*-\s*/, "").trim();
          const cod = p.productCode || "";
          const um = p.measuringUnit || p.productMeasuringUnit || "";
          if (!denumire) continue;
          for (const o of p.operations || []) {
            const numar = o.documentNumber || o.stockDocumentId || "";
            if (!numar) continue;
            const tip = String(o.documentType || o.documentSymbol || "");
            const cheie = `${tip}|${o.documentSeries || ""}|${numar}`;
            let doc = documente.get(cheie);
            if (!doc) {
              doc = { document: cheie, tip, data: doarZi(o.operationDate), finite: [], consum: [] };
              documente.set(cheie, doc);
            }
            const intra = Number(o.quantityIn) || 0;
            const iese = Number(o.quantityOut) || 0;
            if (intra > 0) doc.finite.push({ produs: denumire, cod, um, cantitate: intra });
            else if (iese > 0) doc.consum.push({ produs: denumire, cod, um, cantitate: iese });
          }
        }
      }
      if (!peAceastaPagina) break;
      vazute += peAceastaPagina;
    }

    const randuri = [...documente.values()].filter(
      (d) =>
        d.finite.length &&
        d.consum.length &&
        (E_PRODUCTIE.test(d.tip) || !NU_E_PRODUCTIE.test(d.tip))
    );
    await trimite("productie", randuri, `sincronizare ${S.firma()} — producție ${zile} zile`);
    return randuri.length;
  };

  // ---- totul, pe rând -----------------------------------------------------
  // Un pas căzut nu-i oprește pe ceilalți: fiecare are try/catch, iar ce n-a
  // mers rămâne scris în jurnal cu motivul.
  S.tot = async function (zile) {
    const z = zile || 14;
    S.jurnal = [];
    log("pornit", { firma: S.firma(), zile: z });
    for (const [nume, f] of [
      ["facturi", () => S.facturi(z)],
      ["incasari", () => S.incasari(z)],
      ["productie", () => S.productie(Math.max(z, 30))],
      ["costuri", () => S.costuri()],
    ]) {
      try {
        await f();
      } catch (e) {
        log(`${nume}: EȘUAT`, { motiv: String((e && e.message) || e).slice(0, 200) });
      }
    }
    log("gata");
    return S.jurnal;
  };

  S.stare = () => S.jurnal;

  console.log("[sync] încărcată. window.__sync.tot(14) → window.__sync.stare()");
})();
