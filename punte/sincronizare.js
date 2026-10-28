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
// CE S-A STRICAT ȘI CUM S-A REPARAT (24.10.2026)
//
// Din 23.09 sincronizarea de noapte cădea în fiecare zi cu „Raportul
// /raport/facturi/ n-a răspuns în timp util." Nu SmartBill era de vină:
// verificat pe viu, adresa se potrivea cu tiparul, iar raportul răspundea în
// sub 9 secunde cu 38 KB. Ce nu mergea era declanșarea.
//
// Vechiul mers era: încarcă iframe-ul complet → pune petecul pe XHR →
// cheamă fnDraw() ca să ceară din nou datele. Pasul trei e cel care pica.
// `reincarca()` se declara mulțumit de îndată ce exista `$(tabel).dataTable`
// — adică de îndată ce pluginul DataTables era încărcat, nu de îndată ce
// TABELUL era pornit ca DataTable cu sursă pe server. Chemat prea devreme,
// `$(t).dataTable()` nu redesenează tabelul existent, ci pornește unul nou,
// local, fără sAjaxSource. fnDraw() al lui redesenează în pagină și nu cere
// nimic de la server. Nicio cerere, niciun răspuns, 45 de secunde de
// așteptare și eroarea de mai sus — care arăta spre SmartBill, deși vina era
// la noi.
//
// Mersul nou nu mai are nevoie de pasul trei deloc. Petecul se pune DEVREME,
// cât documentul din iframe e încă la `readyState: "loading"`, deci înainte
// ca pagina să-și facă singură prima cerere. Cererea aia, a ei, primește
// perioada noastră înainte să plece, iar răspunsul ei e răspunsul nostru. Nu
// mai declanșăm nimic: lăsăm pagina să facă ce ar fi făcut oricum.
// Măsurat pe /raport/facturi/: petec pus la 723 ms, răspuns complet la 4,6 s.
//
// fnDraw a rămas ca plasă de siguranță, pentru cazul în care o pagină nu
// cere nimic de la sine — dar acum se cheamă doar după ce tabelul chiar e un
// DataTable cu sursă pe server, și doar dacă n-a plecat nicio cerere.
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
  //
  // CE S-A STRICAT ȘI CUM (descoperit 27.10.2026)
  //
  // Funcția căuta numele firmei cu o expresie regulată peste TOT textul
  // paginii și lua prima potrivire. Pe raportul de facturi, printre clienți
  // stă și „WAREHOUSE ALL SRL” — o firmă din grup, care e în același timp
  // client al Cash Machine. Când potrivirea aia venea prima, lotul întreg
  // pleca spre ERP cu firma emitentă greșită.
  //
  // Asta nu rămânea o greșeală de etichetă. În ERP cheia de dedublare e
  // SERIE|NUMĂR|FIRMĂ (vezi lib/documente.js): cu altă firmă în cheie,
  // aceleași facturi nu se mai recunoșteau ca fiind deja în bază și intrau a
  // doua oară. Patru facturi din 20.10 — CSHM3322, 3323, 3324, 3325 — s-au
  // dublat exact așa: 81.757,76 lei de vânzări care nu existau, și care nu
  // se vedeau nicăieri ca eroare, fiindcă puntea raporta cinstit „create”.
  //
  // Acum se citește din elementul care chiar ține firma sesiunii, din antetul
  // SmartBill. Expresia regulată a rămas ca plasă de siguranță, dar caută
  // numai în antet, niciodată în tabel — un nume de client nu mai poate trece
  // drept firma noastră. Dacă nu se găsește nimic, întoarce gol: ERP-ul pune
  // atunci firma implicită, ceea ce e tot ce era și înainte de potrivirea
  // greșită.
  // Numele firmei, plus forma juridică dacă e scrisă după el. Vechea formă
  // era „CASH MACHINE[^\n]{0,12}" — adică „numele și încă până la 12
  // caractere, orice ar fi ele". Pe un antet unde după nume urmează
  // „Deconectare", ieșea „WAREHOUSE ALL SRL D", care nu se potrivește cu
  // nimic din tabela de firme a ERP-ului și cade tăcut pe firma implicită.
  // Acum se cere explicit forma juridică, sau nimic.
  const NUME_FIRME = /(CASH MACHINE|WAREHOUSE ALL|MARINE BRANDING|YACHTMAG|SET ?SAIL)(\s+S\.?\s*R\.?\s*L\.?|\s+S\.?\s*A\.?)?/i;
  S.firmaDin = function (doc) {
    const d = doc || document;
    const e = d.querySelector(".details-company");
    const dinAntet = e ? String(e.innerText || e.textContent || "").replace(/\s+/g, " ").trim() : "";
    if (dinAntet) return dinAntet;
    const cap = d.querySelector("header, .navbar, .topbar, #header");
    const t = cap ? cap.innerText || cap.textContent || "" : "";
    const m = String(t).match(NUME_FIRME);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  };
  S.firma = function () {
    return S.firmaDin(document);
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

  // Deschide raportul într-un iframe ascuns, îi rescrie perioada în prima lui
  // cerere și îi întoarce răspunsul JSON. `declanseaza` a rămas ca plasă de
  // siguranță: se folosește doar dacă pagina n-a cerut nimic de la sine.
  async function raport(cale, potrivesteUrl, filtru, declanseaza) {
    const dorm = (ms) => new Promise((r) => setTimeout(r, ms));
    const cadru = document.createElement("iframe");
    cadru.style.cssText = "position:fixed;left:-9999px;top:0;width:1200px;height:800px;opacity:0";
    cadru.src = cale;
    document.body.appendChild(cadru);

    // Ce s-a întâmplat, pas cu pas. Dacă pică, mesajul de eroare spune exact
    // unde s-a oprit — nu mai arătăm cu degetul spre SmartBill pentru o
    // greșeală de-a noastră, cum s-a întâmplat o lună întreagă.
    const urma = { petecLaMs: null, readyStateLaPetec: null, cereri: 0, incarcat: false, redesenat: false };
    let raspuns = null;
    let pus = false;
    const t0 = Date.now();

    const pune = () => {
      if (pus) return;
      const w = cadru.contentWindow;
      const d = cadru.contentDocument;
      // `about:blank` e documentul de dinainte de navigare: dacă punem
      // petecul pe el, se pierde când sosește documentul adevărat.
      if (!w || !d || !d.URL || d.URL.indexOf("about:blank") !== -1 || !w.XMLHttpRequest) return;
      const oo = w.XMLHttpRequest.prototype.open;
      const os = w.XMLHttpRequest.prototype.send;
      w.XMLHttpRequest.prototype.open = function (m, u) {
        // unele rapoarte cer o cale relativă ("ajax/"), altele una absolută;
        // o aducem la aceeași formă, altfel filtrul nu recunoaște cererea
        try {
          this.__u = new URL(u, w.location.href).pathname;
        } catch (e) {
          this.__u = String(u || "");
        }
        return oo.apply(this, arguments);
      };
      w.XMLHttpRequest.prototype.send = function (b) {
        if (potrivesteUrl.test(String(this.__u || ""))) {
          urma.cereri++;
          try {
            const p = new URLSearchParams(b);
            for (const [k, v] of Object.entries(filtru)) p.set(k, v);
            b = p.toString();
          } catch (e) {
            /* raport cu alt format de corp: îl lăsăm cum e */
          }
          this.addEventListener("load", function () {
            raspuns = this.responseText;
          });
        }
        return os.call(this, b);
      };
      pus = true;
      urma.petecLaMs = Date.now() - t0;
      urma.readyStateLaPetec = d.readyState;
    };

    try {
      // Pasul 1: prindem documentul cât e încă în „loading" și punem petecul
      // înainte să plece prima cerere a paginii.
      while (Date.now() - t0 < 30000 && !pus) {
        try {
          pune();
        } catch (e) {
          /* documentul încă nu e al nostru: mai încercăm */
        }
        if (!pus) await dorm(20);
      }
      if (!pus) throw new Error(`Raportul ${cale} nu s-a încărcat deloc în 30 s.`);

      // Pasul 2: așteptăm răspunsul cererii pe care și-o face singură pagina.
      while (Date.now() - t0 < 45000 && !raspuns) {
        if (cadru.contentDocument && cadru.contentDocument.readyState === "complete") urma.incarcat = true;
        await dorm(100);
      }

      // Pasul 3, doar dacă n-a plecat nicio cerere: împingem noi tabelul.
      // Condiția e mai strictă decât înainte — `declanseaza` întoarce ceva
      // numai când tabelul chiar e pornit cu sursă pe server.
      if (!raspuns && !urma.cereri) {
        let actiune = null;
        try {
          actiune = declanseaza(cadru.contentDocument, cadru.contentWindow);
        } catch (e) {
          actiune = null;
        }
        if (actiune) {
          urma.redesenat = true;
          if (typeof actiune === "function") actiune();
          else actiune.click();
          const t1 = Date.now();
          while (Date.now() - t1 < 45000 && !raspuns) await dorm(100);
        }
      }

      if (!raspuns) {
        throw new Error(
          `Raportul ${cale} n-a răspuns în timp util. ` +
            `Petec pus la ${urma.petecLaMs} ms (readyState ${urma.readyStateLaPetec}), ` +
            `pagina ${urma.incarcat ? "s-a încărcat" : "NU s-a încărcat complet"}, ` +
            `${urma.cereri} cereri potrivite, redesenare ${urma.redesenat ? "încercată" : "nu a fost nevoie"}.`
        );
      }
      log(`${cale}: cules`, { ms: Date.now() - t0, cereri: urma.cereri, petecLaMs: urma.petecLaMs });
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

  // Cum îi cerem raportului să se reîncarce, dacă ajungem până acolo.
  //
  // AICI A FOST GREȘEALA care a oprit sincronizarea o lună. Verificarea era
  // `typeof $(t).dataTable === "function"` — adevărată de îndată ce pluginul
  // DataTables e încărcat, chiar dacă TABELUL n-a fost încă pornit. Pe un
  // tabel nepornit, `$(t).dataTable()` nu redesenează nimic: pornește un
  // DataTable nou, local, fără sAjaxSource. fnDraw() al lui nu cere nimic de
  // la server, deci nu venea niciun răspuns și cădea cu „n-a răspuns în timp
  // util", arătând spre SmartBill.
  //
  // Acum căutăm tabelul în `$.fn.dataTableSettings` — lista tabelelor chiar
  // pornite — și cerem redesenarea doar dacă are sursă pe server. Altfel
  // întoarcem null, iar `raport()` spune limpede că n-a găsit ce să apese.
  const dtPornit = (win, t) => {
    const $ = win.jQuery;
    if (!$ || !t) return null;
    const toate = ($.fn && $.fn.dataTableSettings) || [];
    for (const s of toate) if (s && s.nTable === t && s.sAjaxSource) return s;
    return null;
  };
  const reincarca = (idTabel, text) => (doc, win) => {
    try {
      const t = idTabel ? doc.getElementById(idTabel) : null;
      if (dtPornit(win, t)) return () => win.jQuery(t).dataTable().fnDraw();
    } catch (e) {
      /* pagina n-are jQuery: mergem pe buton */
    }
    return (
      doc.querySelector("#change_iDisplayLength") ||
      [...doc.querySelectorAll("a,button")].find((e) => (e.innerText || "").trim() === (text || "Aplica")) ||
      null
    );
  };

  // ---- facturi emise ------------------------------------------------------
  S.facturi = async function (zile) {
    const j = await raport(
      "/raport/facturi/",
      /\/raport\/facturi\/ajax/,
      { sSearch: JSON.stringify({ from: acumMinus(zile), to: aziText(), currency: "0" }), iDisplayStart: "0", iDisplayLength: "5000" },
      reincarca("invoices_datatable")
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
      { sSearch: JSON.stringify({ from: acumMinus(zile), to: aziText(), currency: "0" }), iDisplayStart: "0", iDisplayLength: "5000" },
      reincarca("payments_datatable")
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
      reincarca(null)
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
  // La Cash Machine o producție se scrie în două hârtii: bonul de consum ia
  // materialele din depozit, iar bonul de predare bagă produsul finit. Ele
  // sunt legate: bonul de consum are `rpIdForBC` = documentul de predare. Deci
  // luăm cantitățile din raportul de mișcări (care le dă pe document) și le
  // împerechem după legătura asta. Așa iese rețeta exactă, nu una ghicită
  // după zi.
  const CSRF = () =>
    (document.querySelector("input[name=csrfmiddlewaretoken]") || {}).value ||
    (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] ||
    "";

  async function cere(cale, cautare) {
    const r = await fetch(cale, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRFToken": CSRF(),
      },
      body: "sSearch=" + encodeURIComponent(JSON.stringify(cautare)),
    });
    const j = await r.json();
    if (j && j.csrf_fails) throw new Error(`SmartBill a refuzat cererea către ${cale}. Reîncarcă pagina și încearcă din nou.`);
    return j;
  }

  // ce s-a mișcat pe fiecare document, produs cu produs
  async function miscariPeDocument(de, la) {
    const perDoc = new Map();
    let total = Infinity;
    let vazute = 0;
    for (let pagina = 1; pagina <= 30 && vazute < total; pagina++) {
      const j = await cere("/gestiune/raport/miscari_stocuri/ajax/", {
        product_list: [], product_name: "", product_code: "", warehouse: "-1",
        from: de, to: la, measuring_unit: -1, document_types: [], document_series: [],
        show_unit_price: false, show_product_totals: false,
        hide_no_stock_and_transactions: true, hide_no_transactions: true, hide_no_stock: false,
        page: pagina, results_per_page: 200,
      });
      const m = String((j && j.info) || "").match(/din\s+(\d+)/);
      if (m) total = Number(m[1]);
      let peAceastaPagina = 0;
      for (const w of (j && j.warehouses) || []) {
        for (const p of w.products || []) {
          peAceastaPagina++;
          const denumire = String(p.productName || "").replace(/^\s*\d+\s*-\s*/, "").trim();
          const cod = p.productCode || "";
          const um = p.measuringUnit || p.productMeasuringUnit || p.mu || "";
          if (!denumire) continue;
          for (const o of p.operations || []) {
            const id = o.stockDocumentId;
            if (!id) continue;
            let doc = perDoc.get(id);
            if (!doc) {
              doc = {
                id,
                tip: String(o.documentType || o.documentSymbol || ""),
                nume: `${o.documentSeries || ""}${o.documentNumber || ""}`,
                data: doarZi(o.operationDate),
                intrari: [],
                iesiri: [],
              };
              perDoc.set(id, doc);
            }
            const intra = Number(o.quantityIn) || 0;
            const iese = Number(o.quantityOut) || 0;
            if (intra > 0) doc.intrari.push({ produs: denumire, cod, um, cantitate: intra });
            else if (iese > 0) doc.iesiri.push({ produs: denumire, cod, um, cantitate: iese });
          }
        }
      }
      if (!peAceastaPagina) break;
      vazute += peAceastaPagina;
    }
    return perDoc;
  }

  // legătura bon de consum → bon de predare
  async function legaturiConsum(de, la) {
    const legaturi = new Map();
    let total = Infinity;
    for (let pagina = 1; pagina <= 30 && legaturi.size < total; pagina++) {
      const j = await cere("/gestiune/raport/bonuri-cosum/ajax/", { from: de, to: la, page: pagina, results_per_page: 100 });
      if (typeof j.documentsCount === "number") total = j.documentsCount;
      const d = j.documents || [];
      if (!d.length) break;
      for (const x of d) {
        if (x.isAnulled || x.isDraft) continue;
        if (x.rpIdForBC && x.rpIdForBC > 0) legaturi.set(x.documentId, x.rpIdForBC);
      }
      if (d.length < 100) break;
    }
    return legaturi;
  }

  // documente care sigur nu sunt producție, chiar dacă au și intrări și ieșiri
  const NU_E_PRODUCTIE = /transfer|inventar|recep|aviz|factur|retur|dezmembr|ajustare/i;
  const E_PRODUCTIE = /produc|predare/i;

  S.productie = async function (zile) {
    const de = acumMinus(zile);
    const la = aziText();
    const perDoc = await miscariPeDocument(de, la);
    const legaturi = await legaturiConsum(de, la);

    const randuri = [];
    const folosite = new Set();
    for (const [idConsum, idPredare] of legaturi) {
      const bc = perDoc.get(idConsum);
      const bp = perDoc.get(idPredare);
      if (!bc || !bp || !bc.iesiri.length || !bp.intrari.length) continue;
      randuri.push({
        document: `${bp.nume} ← ${bc.nume}`,
        tip: "productie",
        data: bp.data || bc.data,
        finite: bp.intrari,
        consum: bc.iesiri,
      });
      folosite.add(idConsum);
      folosite.add(idPredare);
    }

    // hârtii care au și intrare și ieșire în același document (raport de
    // producție clasic), dacă mai există așa ceva
    for (const [id, d] of perDoc) {
      if (folosite.has(id)) continue;
      if (!d.intrari.length || !d.iesiri.length) continue;
      if (!E_PRODUCTIE.test(d.tip) && NU_E_PRODUCTIE.test(d.tip)) continue;
      randuri.push({ document: d.nume, tip: d.tip, data: d.data, finite: d.intrari, consum: d.iesiri });
    }

    await trimite("productie", randuri, `sincronizare ${S.firma()} — producție ${zile} zile`);
    return randuri.length;
  };

  // ---- totul, pe rând -----------------------------------------------------
  // Un pas căzut nu-i oprește pe ceilalți: fiecare are try/catch, iar ce n-a
  // mers rămâne scris în jurnal cu motivul.
  //
  // FIECARE PAS SE ÎNCEARCĂ DE DOUĂ ORI. Rapoartele SmartBill sunt leneșe la
  // prima deschidere din sesiune — pe 21.09.2026 raportul de facturi a dat
  // „n-a răspuns în timp util", iar la a doua încercare a mers din prima și a
  // adus 32 de rânduri. Fără reîncercare, sincronizarea raporta „gata" cu
  // facturile lipsă, ceea ce e mai rău decât o eroare: pare că a mers.
  //
  // La final se întoarce un rezumat, nu jurnalul brut: dacă a căzut ceva,
  // trebuie să se vadă de la prima privire, nu după ce citești zece rânduri.
  S.tot = async function (zile) {
    const z = zile || 14;
    S.jurnal = [];
    log("pornit", { firma: S.firma(), zile: z });
    const rezultat = { firma: S.firma(), zile: z, reusite: {}, esuate: {} };
    for (const [nume, f] of [
      ["facturi", () => S.facturi(z)],
      ["incasari", () => S.incasari(z)],
      ["productie", () => S.productie(Math.max(z, 30))],
      ["costuri", () => S.costuri()],
    ]) {
      let ultimaEroare = null;
      for (let incercare = 1; incercare <= 2; incercare++) {
        try {
          rezultat.reusite[nume] = await f();
          ultimaEroare = null;
          break;
        } catch (e) {
          ultimaEroare = String((e && e.message) || e).slice(0, 200);
          if (incercare === 1) log(`${nume}: a picat, mai încerc o dată`, { motiv: ultimaEroare });
        }
      }
      if (ultimaEroare) {
        rezultat.esuate[nume] = ultimaEroare;
        log(`${nume}: EȘUAT`, { motiv: ultimaEroare });
      }
    }
    const cazute = Object.keys(rezultat.esuate);
    log(cazute.length ? `gata, DAR a picat: ${cazute.join(", ")}` : "gata, tot a mers");
    return rezultat;
  };

  S.stare = () => S.jurnal;

  console.log("[sync] încărcată. window.__sync.tot(14) → window.__sync.stare()");
})();
