"use strict";
// CRM · Comisionul meu.
//
// Pagina agentului despre banii lui. Trei întrebări, în ordinea în care și le
// pune omul: cât am de luat acum, cât urmează să am, și cât aș putea avea.
//
// Regulile, așa cum le-a dat Vali:
//
//  * comisionul se calculează din TOATE încasările intrate în luna curentă pe
//    facturile agentului, indiferent când au fost emise facturile. O factură
//    din martie încasată în august aduce comision în august;
//  * butonul de cerere e activ de pe 25 până la sfârșitul lunii;
//  * ce cere se scade din disponibil — deci după ce a cerut tot, „de încasat"
//    arată 0;
//  * ce nu cere nu se pierde: la sfârșitul lunii se reportează, iar luna
//    următoare pornește cu reportul deja în cont;
//  * poate cere și mai puțin decât are; diferența îi rămâne.
//
// Nu ținem un sold în bază, ci doar cererile. Soldul se recalculează de
// fiecare dată din încasări minus ce s-a cerut — un sold ținut separat ar
// putea ieși din sincron cu realitatea, ăsta nu poate.
const db = require("../lib/db");
const { ALOC_FACTURA } = require("./alocari");
const cb = require("../lib/comision-baza");
const { esc, money, layout, table, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);
const ZI_DESCHIDERE = 25;
const EMAIL_COMISION = "valentin.oeru@cashmachine.ro";

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function lunaLui(dataISO) {
  return String(dataISO).slice(0, 7);
}

function lunaMinus(luna, n) {
  const d = new Date(luna + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
}

function ultimaZi(luna) {
  const a = Number(luna.slice(0, 4));
  const m = Number(luna.slice(5, 7));
  return `${luna}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

const LUNI_RO = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
function numeLuna(luna) {
  return `${LUNI_RO[Number(luna.slice(5, 7)) - 1]} ${luna.slice(0, 4)}`;
}

function lei(v) {
  return money(v);
}

// Încasările agentului pe lună, pe ultimele N luni. Baza comisionului:
// fiecare plată se împarte între agenții facturii după procentele din
// alocare, exact ca în biroul agentului și în raportul de comisioane.
async function incasariPeLuni(agentId, deLaLuna) {
  return db
    .prepare(
      `SELECT SUBSTR(pl.data, 1, 7) AS luna,
              COALESCE(SUM(pl.suma * al.procent / 100.0), 0) AS incasat,
              COALESCE(SUM(${cb.incasatNet("pl", "f")} * al.procent / 100.0), 0) AS baza,
              COUNT(DISTINCT f.id) AS facturi
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         ${cb.joinRaport("f")}
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0 AND al.utilizator_id = ? AND pl.data >= ?
          AND ${cb.faraManual("f")}
        GROUP BY SUBSTR(pl.data, 1, 7)
        ORDER BY luna`
    )
    .all(agentId, deLaLuna + "-01");
}

// Facturile din care a ieșit comisionul lunii, una câte una.
//
// De ce există: pagina arăta doar totalul lunii, iar agentul n-avea cum să
// verifice cifra — trebuia să creadă pe cuvânt un număr din care îi iese
// salariul. Aici sunt chiar facturile pe care au intrat banii în luna
// curentă, cu partea lui din fiecare. Suma coloanei de comision este exact
// cifra de sus; dacă nu e, se vede imediat pe ce factură se rupe socoteala.
async function facturiCareAuAdusComision(agentId, luna) {
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii,
              p.nume AS client,
              MAX(al.procent) AS cota_agent,
              COUNT(pl.id) AS nr_plati,
              MAX(pl.data) AS ultima_plata,
              COALESCE(SUM(pl.suma), 0) AS incasat_factura,
              COALESCE(SUM(pl.suma * al.procent / 100.0), 0) AS incasat_partea_mea,
              COALESCE(SUM(${cb.incasatNet("pl", "f")} * al.procent / 100.0), 0) AS baza
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         ${cb.joinRaport("f")}
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         LEFT JOIN parteneri p ON p.id = f.partener_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0 AND al.utilizator_id = ? AND SUBSTR(pl.data, 1, 7) = ?
          AND ${cb.faraManual("f")}
        GROUP BY f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, p.nume
        ORDER BY baza DESC, ultima_plata DESC`
    )
    .all(agentId, luna);
}

// Ce s-a adăugat cu mâna la comision, pe luni. Se pune peste baza venită din
// încasări, ca ledgerul să numere și una, și alta.
async function manualPeLuni(agentId, deLaLuna) {
  return db.prepare(cb.MANUAL_PE_LUNA).all(agentId, deLaLuna);
}

// Baza lunară completă: ce a venit din încasări plus ce s-a pus cu mâna.
// Se cheamă și din pagină, și din ruta de cerere de plată — dacă ar fi
// socotite diferit, agentul ar vedea o sumă pe ecran și ar putea cere alta.
async function bazaPeLuni(agentId, deLaLuna) {
  const incasari = await incasariPeLuni(agentId, deLaLuna);
  const manuale = await manualPeLuni(agentId, deLaLuna);
  const peLuna = new Map(manuale.map((m) => [String(m.luna), Number(m.baza || 0)]));
  for (const r of incasari) {
    const plus = peLuna.get(String(r.luna)) || 0;
    if (plus) { r.baza = Number(r.baza || 0) + plus; peLuna.delete(String(r.luna)); }
  }
  // Lunile care au DOAR adăugiri manuale, nicio încasare, n-ar avea rând deloc.
  for (const [luna, baza] of peLuna) incasari.push({ luna, incasat: 0, baza, facturi: 0 });
  return incasari;
}

// Liniile adăugate manual în luna curentă, ca să apară în listă lângă
// celelalte, marcate ca atare.
async function facturiManualeLuna(agentId, luna) {
  return db
    .prepare(
      `SELECT m.id AS manual_id, m.baza, m.motiv, m.adaugat_la, m.adaugat_de,
              m.fel, COALESCE(m.baza_bruta, m.baza) AS baza_bruta, m.retinere_pct,
              u.nume AS adaugat_de_nume,
              f.id, f.serie, f.numar, f.document_extern, f.data_emiterii,
              p.nume AS client
         FROM comision_manual m
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = m.factura_id
         LEFT JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN utilizatori u ON u.id = m.adaugat_de
        WHERE m.activ = 1 AND m.utilizator_id = ? AND m.luna = ?
        ORDER BY m.baza DESC`
    )
    .all(agentId, luna);
}

// Facturile care pot fi adăugate la comision: ale clientului căutat, care
// n-au intrat niciodată în comisionul cuiva. „N-au intrat" înseamnă că n-au
// linie manuală ȘI că încasările lor (dacă există) n-au mers la agentul
// pentru care căutăm — adică fie n-au fost plătite, fie plata a produs
// comision altcuiva. Pe fiecare rând scrie de ce e eligibilă.
async function facturiDeAdaugat(agentId, cauta) {
  const q = `%${String(cauta || "").trim().toLowerCase()}%`;
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii,
              p.nume AS client,
              COALESCE(n.net, 0) AS net,
              COALESCE(t.total, 0) AS total,
              COALESCE(pl.platit, 0) AS platit,
              (SELECT u2.nume FROM ${ALOC_FACTURA} a2 JOIN utilizatori u2 ON u2.id = a2.utilizator_id
                WHERE a2.factura_id = f.id ORDER BY a2.procent DESC LIMIT 1) AS agent_curent
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${cb.SUB_NET} n ON n.factura_id = f.id
         LEFT JOIN ${cb.SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) x
                     GROUP BY factura_id) pl ON pl.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0
          AND LOWER(p.nume) LIKE ?
          AND ${cb.faraManual("f")}
          AND NOT EXISTS (
                SELECT 1 FROM (SELECT * FROM plati WHERE activ = 1) p2
                  JOIN ${ALOC_FACTURA} a3 ON a3.factura_id = f.id
                 WHERE p2.factura_id = f.id AND a3.utilizator_id = ?)
        ORDER BY f.data_emiterii DESC
        LIMIT 60`
    )
    .all(q, agentId);
}

// Facturile emise și neîncasate integral: comisionul care urmează să vină.
async function facturiNeincasate(agentId) {
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.data_emiterii, f.data_scadenta, p.nume AS partener,
              al.procent,
              COALESCE(t.total, 0) AS total,
              COALESCE(n.net, 0) AS net,
              COALESCE(pl.platit, 0) AS platit
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         LEFT JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${cb.SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN ${cb.SUB_NET} n ON n.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati
                     GROUP BY factura_id) pl ON pl.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0 AND al.utilizator_id = ?
          AND ${cb.faraManual("f")}
          AND COALESCE(t.total, 0) - COALESCE(pl.platit, 0) > 1
        ORDER BY COALESCE(f.data_scadenta, f.data_emiterii)`
    )
    .all(agentId);
}

// Oportunitățile deschise ale agentului: comisionul care s-ar putea face.
// Probabilitatea e cea uzuală de pipeline — se arată la vedere, ca omul să
// știe că e o presupunere, nu o promisiune.
const SANSA = { lead: 0.1, calificat: 0.25, oferta: 0.5, negociere: 0.75 };
async function oportunitatiDeschise(agentId) {
  return db
    .prepare(
      `SELECT o.id, o.titlu, o.valoare_estimata, o.stadiu, o.data_estimata_inchidere, p.nume AS partener
         FROM oportunitati o LEFT JOIN parteneri p ON p.id = o.partener_id
        WHERE o.atribuit_lui = ? AND o.stadiu NOT IN ('castigat', 'pierdut')
        ORDER BY o.valoare_estimata DESC`
    )
    .all(agentId)
    .catch(() => []);
}

// Comenzile agentului care încă n-au fost facturate. Sunt deja câștigate —
// clientul a comandat — dar banii n-au plecat încă spre noi, deci comisionul
// din ele e potențial, nu viitor.
//
// Registrul de comenzi vine dintr-un Excel fără prețuri, deci valoarea se ia
// în ordinea asta: ce a scris agentul pe comandă; altfel media facturilor
// clientului din ultimul an; altfel nimic — și atunci comanda se numără, dar
// nu se pune la lei. Cifra e cinstită doar dacă spune și cât din ea lipsește.
async function comenziNefacturate(agentId) {
  const randuri = await db
    .prepare(
      `SELECT c.id, c.numar, c.tip_produs, c.cantitate, c.um, c.data_livrare, c.valoare_estimata,
              c.partener_id, COALESCE(p.nume, c.client_text) AS client
         FROM comenzi_productie c LEFT JOIN parteneri p ON p.id = c.partener_id
        WHERE c.agent_id = ? AND c.status = 'in_productie'
          AND (c.facturat IS NULL OR c.facturat = '' OR LOWER(c.facturat) = 'nu')
        ORDER BY (c.data_livrare IS NULL OR c.data_livrare = ''), c.data_livrare DESC, c.id DESC`
    )
    .all(agentId)
    .catch(() => []);
  if (!randuri.length) return [];

  // Media pe client, dintr-o singură interogare — nu una pe fiecare comandă.
  const ids = [...new Set(randuri.map((r) => r.partener_id).filter(Boolean))];
  const medii = new Map();
  if (ids.length) {
    const anul = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const m = await db
      .prepare(
        `SELECT f.partener_id, AVG(ABS(t.total)) AS medie
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total
                   FROM facturi_linii GROUP BY factura_id) t ON t.factura_id = f.id
          WHERE f.partener_id IN (${ids.map(() => "?").join(",")}) AND f.directie = 'vanzare'
            AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut') AND f.intercompany = 0
            AND f.data_emiterii >= ? AND t.total > 0
          GROUP BY f.partener_id`
      )
      .all(...ids, anul)
      .catch(() => []);
    for (const r of m) medii.set(Number(r.partener_id), Number(r.medie) || 0);
  }

  return randuri.map((r) => {
    const scrisa = Number(r.valoare_estimata) || 0;
    const media = medii.get(Number(r.partener_id)) || 0;
    const valoare = scrisa || media;
    return { ...r, valoare, temei: scrisa ? "scrisă pe comandă" : media ? "media facturilor clientului" : "fără temei" };
  });
}

async function cererileLui(agentId, deLaLuna) {
  return db
    .prepare("SELECT * FROM cereri_comision WHERE utilizator_id = ? AND luna >= ? ORDER BY luna DESC, id DESC")
    .all(agentId, deLaLuna);
}

// Fereastra de cerere: de pe 25 până la ultima zi a lunii.
function fereastra(dataISO) {
  const zi = Number(String(dataISO).slice(8, 10));
  const luna = lunaLui(dataISO);
  return {
    deschisa: zi >= ZI_DESCHIDERE,
    zi,
    seDeschideLa: `${luna}-${String(ZI_DESCHIDERE).padStart(2, "0")}`,
    seInchideLa: ultimaZi(luna),
  };
}

// Toată socoteala, într-un singur loc: câștigat pe lună, cerut pe lună,
// reportul care curge dintr-o lună în alta, disponibilul de acum.
//
// Reportul nu curge din istorie. Comisionul se ține în ERP de acum: dacă am
// aduna la report tot ce s-a încasat în ultimele douăsprezece luni și nu s-a
// cerut, ar ieși un sold de un milion care n-a fost niciodată datorat — omul
// și-a luat banii pe alte căi, ERP-ul doar n-a știut. De-aia contorul pornește
// din luna primei cereri: de acolo încolo ERP-ul chiar știe ce s-a cerut și ce
// nu, deci poate reporta cinstit. Lunile dinainte se arată ca istoric, fără
// să se adune.
function socoteala(luni, incasari, cereri, pct, startLedger) {
  const hInc = new Map(incasari.map((r) => [r.luna, nr(r.incasat)]));
  // Încasatul e cu TVA (atât plătește clientul); comisionul se dă din partea
  // fără TVA. Ținem ambele: una se arată, cealaltă se înmulțește cu procentul.
  const hBaza = new Map(incasari.map((r) => [r.luna, nr(r.baza)]));
  const hCer = new Map();
  for (const c of cereri) hCer.set(c.luna, (hCer.get(c.luna) || 0) + nr(c.suma_ceruta));

  const rez = [];
  let report = 0;
  for (const luna of luni) {
    const conteaza = !startLedger || luna >= startLedger;
    const reportEfectiv = conteaza ? report : 0;
    const incasat = hInc.get(luna) || 0;
    const baza = hBaza.get(luna) || 0;
    const castigat = (baza * pct) / 100;
    const cerut = hCer.get(luna) || 0;
    const disponibil = reportEfectiv + castigat - cerut;
    rez.push({ luna, incasat, baza, castigat, cerut, report: reportEfectiv, disponibil, conteaza });
    report = conteaza ? disponibil : 0;
  }
  return rez;
}

// Din ce lună începe să curgă reportul: prima lună în care s-a cerut ceva.
// Cât timp n-a cerut nimeni nimic, contorul pornește din luna curentă.
function startLedger(cereri, lunaAcum) {
  const luniCereri = cereri.map((c) => String(c.luna)).filter(Boolean).sort();
  return luniCereri.length ? luniCereri[0] : lunaAcum;
}

// Căutarea din lista de facturi. Filtrează pe loc, fără să reîncarce pagina —
// la 20-30 de facturi un dus-întors la server ar fi mai lent decât tastatul.
// Totalurile se resocotesc pe ce rămâne vizibil, ca să poți vedea imediat cât
// comision a adus un anumit client: scrii numele lui și citești totalul.
// Diacriticele se scot din amândouă părțile, ca „Delivery" să găsească și
// „DELIVERY SOLUTIONS", iar „aquila" să găsească „AQUILA".
// Cât se reține când agentul ia comisionul înainte să intre banii. E costul
// banului luat mai devreme: firma plătește acum dintr-o factură care poate fi
// încasată peste 60 de zile, sau deloc.
const RETINERE_AVANS = 3;

const CAUTARE_FACTURI = `
<script>
(function () {
  var cutie = document.getElementById("cautaFacturiComision");
  var camp = document.getElementById("cautaFactura");
  if (!cutie || !camp) return;
  var randuri = [].slice.call(cutie.querySelectorAll("tbody tr"));
  var cate = document.getElementById("cateFacturi");
  var tInc = document.getElementById("totIncasat");
  var tBaza = document.getElementById("totBaza");
  var tCom = document.getElementById("totComision");
  function simplu(s) {
    return String(s).toLowerCase()
      .replace(/[\u0103\u00e2]/g, "a").replace(/\u00ee/g, "i")
      .replace(/[\u0219\u015f]/g, "s").replace(/[\u021b\u0163]/g, "t");
  }
  function bani(v) {
    return v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";
  }
  function val(tr, fel) {
    var e = tr.querySelector('[data-cv="' + fel + '"]');
    return e ? Number(e.getAttribute("data-v") || 0) : 0;
  }
  function filtreaza() {
    var q = simplu(camp.value.trim());
    var n = 0, inc = 0, baza = 0, com = 0;
    for (var i = 0; i < randuri.length; i++) {
      var tr = randuri[i];
      var arata = !q || simplu(tr.textContent).indexOf(q) !== -1;
      tr.style.display = arata ? "" : "none";
      if (arata) { n++; inc += val(tr, "inc"); baza += val(tr, "baza"); com += val(tr, "com"); }
    }
    if (tInc) tInc.textContent = bani(inc);
    if (tBaza) tBaza.textContent = bani(baza);
    if (tCom) tCom.textContent = bani(com);
    if (cate) {
      cate.textContent = q
        ? n + " din " + randuri.length + (randuri.length === 1 ? " factură" : " facturi")
        : randuri.length + (randuri.length === 1 ? " factură" : " facturi");
    }
  }
  // Rândurile puse cu mâna primesc un fundal, ca să se vadă că nu vin din
  // încasări. Se face din script, fiindcă ajutorul de tabel nu știe să pună
  // atribute pe rând.
  for (var k = 0; k < randuri.length; k++) {
    var marca = randuri[k].querySelector("[data-manual]");
    if (!marca) continue;
    randuri[k].style.background = marca.getAttribute("data-manual") === "avans"
      ? "rgba(200,60,60,0.08)"
      : "rgba(196,127,23,0.10)";
  }
  camp.addEventListener("input", filtreaza);
  camp.addEventListener("search", filtreaza);
})();
<\/script>`;

function register(router) {
  router.get("/crm/comision", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    let agentId = ctx.user.id;
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      if (Number.isFinite(a) && a > 0) agentId = a;
    }
    const agent = await db.prepare("SELECT id, nume, comision_procent FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm");
    const agenti = esteAdmin
      ? await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin') ORDER BY nume").all()
      : [];
    const pct = nr(agent.comision_procent);

    const aziISO = azi();
    const lunaAcum = lunaLui(aziISO);
    const primaLuna = lunaMinus(lunaAcum, 11);
    const luni = [];
    for (let i = 11; i >= 0; i--) luni.push(lunaMinus(lunaAcum, i));

    const incasari = await bazaPeLuni(agentId, primaLuna);
    const cereri = await db.prepare("SELECT * FROM cereri_comision WHERE utilizator_id = ? ORDER BY luna").all(agentId);
    const start = startLedger(cereri, lunaAcum);
    const rand = socoteala(luni, incasari, cereri, pct, start);
    const acum = rand[rand.length - 1];
    const f = fereastra(aziISO);
    const cereriLunaAsta = cereri.filter((c) => c.luna === lunaAcum);
    const cerutLunaAsta = cereriLunaAsta.reduce((s, c) => s + nr(c.suma_ceruta), 0);

    // ---- facturile din care iese comisionul lunii -------------------------
    const bazaFacturi = (await facturiCareAuAdusComision(agentId, lunaAcum)).map((x) => ({
      ...x,
      incasat_partea_mea: nr(x.incasat_partea_mea),
      baza: nr(x.baza),
      comision: (nr(x.baza) * pct) / 100,
    }));
    // Căutarea pentru „adaugă o factură": merge prin adresă, nu prin AJAX —
    // se vede ce ai căutat, poți da refresh și poți trimite linkul mai departe.
    const cautaAdauga = String(ctx.query.adauga || "").trim();
    const gasiteDeAdaugat = cautaAdauga.length >= 2 ? await facturiDeAdaugat(agentId, cautaAdauga) : [];

    const adaugateManual = (await facturiManualeLuna(agentId, lunaAcum)).map((x) => ({
      ...x,
      manual: true,
      incasat_partea_mea: 0,
      baza: nr(x.baza),
      comision: (nr(x.baza) * pct) / 100,
    }));
    // Cele din încasări se sortează după valoare; cele puse cu mâna stau la
    // sfârșit, evidențiate, ca să se vadă dintr-o privire ce e automat și ce
    // a fost adăugat de om.
    bazaFacturi.sort((a, b) => b.baza - a.baza);
    adaugateManual.sort((a, b) => b.baza - a.baza);
    for (const m of adaugateManual) bazaFacturi.push(m);
    const bazaFacturiTotal = bazaFacturi.reduce((s, x) => s + x.baza, 0);
    const bazaFacturiComision = bazaFacturi.reduce((s, x) => s + x.comision, 0);
    // Dacă lista nu dă exact cât arată capul paginii, o spunem — mai bine o
    // notă vizibilă decât un total care nu se potrivește și nu explică de ce.
    const bazaSePotriveste = Math.abs(bazaFacturiTotal - nr(acum.baza)) < 0.01;

    // ---- comisionul viitor, din facturile neîncasate ----------------------
    const neincasate = await facturiNeincasate(agentId);
    const viitor = neincasate.map((x) => {
      const rest = nr(x.total) - nr(x.platit);
      const restNet = rest * cb.raportNetJs(x.net, x.total, x.data_emiterii);
      return { ...x, rest, restNet, comision: (restNet * nr(x.procent) / 100) * (pct / 100) };
    });
    const viitorTotal = viitor.reduce((s, x) => s + x.comision, 0);

    // Prognoza pe trei luni, după scadență. Ce e deja scadent stă separat:
    // nu e „luna asta", e întârziat, și se citește altfel.
    const cosuri = [
      { cheie: "restant", eticheta: "Deja scadent", suma: 0, n: 0 },
      { cheie: "l0", eticheta: numeLuna(lunaAcum), suma: 0, n: 0 },
      { cheie: "l1", eticheta: numeLuna(lunaMinus(lunaAcum, -1)), suma: 0, n: 0 },
      { cheie: "l2", eticheta: numeLuna(lunaMinus(lunaAcum, -2)), suma: 0, n: 0 },
      { cheie: "dupa", eticheta: "Mai târziu / fără scadență", suma: 0, n: 0 },
    ];
    const lunaPlus = (n) => lunaMinus(lunaAcum, -n);
    for (const x of viitor) {
      const sc = String(x.data_scadenta || "").slice(0, 10);
      let c;
      if (!sc) c = cosuri[4];
      else if (sc < aziISO) c = cosuri[0];
      else if (lunaLui(sc) === lunaAcum) c = cosuri[1];
      else if (lunaLui(sc) === lunaPlus(1)) c = cosuri[2];
      else if (lunaLui(sc) === lunaPlus(2)) c = cosuri[3];
      else c = cosuri[4];
      c.suma += x.comision;
      c.n++;
    }

    // ---- comisionul potențial, din lead-uri ------------------------------
    const oportunitati = await oportunitatiDeschise(agentId);
    const potential = oportunitati.map((o) => {
      const sansa = SANSA[o.stadiu] !== undefined ? SANSA[o.stadiu] : 0.1;
      const brut = (nr(o.valoare_estimata) * pct) / 100;
      return { ...o, sansa, brut, ponderat: brut * sansa };
    });
    const potentialBrut = potential.reduce((s, o) => s + o.brut, 0);
    const potentialPonderat = potential.reduce((s, o) => s + o.ponderat, 0);

    // ---- comisionul din comenzile nefacturate -----------------------------
    // O comandă e deja câștigată, nu o speranță ca un lead — de asta n-are
    // șansă ponderată. Singura necunoscută e valoarea, iar aceea se vede
    // rând cu rând, cu tot cu temeiul ei.
    const comenzi = (await comenziNefacturate(agentId)).map((c) => ({ ...c, comision: (nr(c.valoare) * pct) / 100 }));
    const comenziValoare = comenzi.reduce((s, c) => s + nr(c.valoare), 0);
    const comenziComision = comenzi.reduce((s, c) => s + c.comision, 0);
    const comenziFaraTemei = comenzi.filter((c) => !c.valoare).length;

    const cerutMax = Math.max(0, Math.round(acum.disponibil * 100) / 100);
    const mesaj = String(ctx.query.mesaj || "");
    const eroare = String(ctx.query.eroare || "");

    const body = `
      ${subnavCrm("/crm/comision", ctx.user)}
      ${
        esteAdmin && agenti.length
          ? `<form class="filtre" method="get" action="/crm/comision">
               <label style="font-size:13px;color:var(--text-muted)">Agent</label>
               <select name="agent" onchange="this.form.submit()">
                 ${agenti.map((a) => `<option value="${a.id}"${a.id === agentId ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
               </select>
             </form>`
          : ""
      }
      ${mesaj ? `<div class="detail-box" style="border-left:4px solid var(--success,#2f7d4f)">${esc(mesaj)}</div>` : ""}
      ${eroare ? `<div class="detail-box" style="border-left:4px solid var(--danger)">${esc(eroare)}</div>` : ""}

      <h1 style="margin:6px 0 2px">Comisionul meu — ${esc(agent.nume)}</h1>
      <p style="margin:0 0 16px;color:var(--text-muted);font-size:13px">
        ${numeLuna(lunaAcum)} · procentul tău: <strong>${pct.toLocaleString("ro-RO")}%</strong>
        ${pct ? "" : ' — <span style="color:var(--danger)">nu e setat, deci comisionul iese 0. Se pune din Utilizatori.</span>'}
      </p>

      <div class="com-sus">
        <div class="com-mare">
          <div class="label">De încasat acum</div>
          <div class="suma">${lei(acum.disponibil)}</div>
          <div class="formula">
            report din ${numeLuna(lunaMinus(lunaAcum, 1))} <strong>${lei(acum.report)}</strong>
            + ${pct}% din ${lei(acum.baza)} (baza fără TVA a lunii) <strong>${lei(acum.castigat)}</strong>
            − cerut luna asta <strong>${lei(acum.cerut)}</strong>
          </div>
        </div>

        <div class="com-cerere">
          <div class="label">Cerere de plată</div>
          <div class="nota" style="margin:0 0 8px">
            Acum poți cere <strong>${lei(cerutMax)}</strong>.
            ${
              viitorTotal > 0
                ? `Peste asta, mai poți lua în avans până la <strong>${lei(viitorTotal * (1 - RETINERE_AVANS / 100))}</strong>
                   (${lei(viitorTotal)} brut, minus reținerea de ${RETINERE_AVANS}%) din facturile emise și neîncasate —
                   secțiunea „Ia comisionul mai devreme", mai jos.
                   <br><strong>Maxim total: ${lei(cerutMax + viitorTotal * (1 - RETINERE_AVANS / 100))}</strong>.`
                : "N-ai facturi neîncasate, deci nu poți lua nimic în avans."
            }
          </div>
          ${
            f.deschisa
              ? cerutMax > 0
                ? `<form method="post" action="/crm/comision/cerere" id="formCerere">
                     <input type="hidden" name="agent" value="${agentId}">
                     <label class="field">Cât ceri (lei)
                       <input type="number" id="sumaCeruta" name="suma" min="0.01" max="${cerutMax}" step="0.01" value="${cerutMax}" required>
                     </label>
                     <p id="aviziereCerere" class="nota" style="display:none;color:var(--danger);margin:4px 0 0"></p>
                     <label class="field">Observații (opțional)<input name="observatii" placeholder="ex: jumătate acum, restul luna viitoare"></label>
                     <button class="btn" type="submit" id="butonCerere">Cer plata comisionului</button>
                     <p class="nota">Poți cere și mai puțin — diferența îți rămâne și se reportează în ${numeLuna(lunaMinus(lunaAcum, -1))}.
                        Cererea pleacă pe mail la ${esc(EMAIL_COMISION)}.</p>
                   </form>
                   <script>
                   (function () {
                     var camp = document.getElementById("sumaCeruta");
                     var avert = document.getElementById("aviziereCerere");
                     var buton = document.getElementById("butonCerere");
                     var forma = document.getElementById("formCerere");
                     if (!camp || !avert || !forma) return;
                     var maxim = ${cerutMax};
                     var avans = ${Math.round(viitorTotal * (1 - RETINERE_AVANS / 100) * 100) / 100};
                     function bani(v) {
                       return v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";
                     }
                     function arata(text) {
                       avert.textContent = text;
                       avert.style.display = text ? "block" : "none";
                       if (buton) buton.disabled = !!text;
                     }
                     // Nu-l lăsăm să scrie mai mult: valoarea se taie înapoi la
                     // maxim și i se spune de ce, pe loc. Butonul stă blocat cât
                     // timp cifra din câmp n-are acoperire.
                     function verifica(taie) {
                       var v = Number(String(camp.value).replace(",", "."));
                       if (!camp.value) { arata("Scrie cât ceri."); return; }
                       if (isNaN(v) || v <= 0) { arata("Suma trebuie să fie mai mare decât zero."); return; }
                       if (v > maxim + 0.005) {
                         if (taie) camp.value = maxim.toFixed(2);
                         arata(
                           "Nu poți cere mai mult de " + bani(maxim) + " — atât ai disponibil acum." +
                           (avans > 0
                             ? " Dacă vrei mai mult, ia comisionul în avans din facturile neîncasate, mai jos — încă până la " + bani(avans) + "."
                             : "")
                         );
                         if (taie) setTimeout(function () { arata(""); }, 4000);
                         return;
                       }
                       arata("");
                     }
                     camp.addEventListener("input", function () { verifica(false); });
                     camp.addEventListener("change", function () { verifica(true); });
                     camp.addEventListener("blur", function () { verifica(true); });
                     forma.addEventListener("submit", function (e) {
                       var v = Number(String(camp.value).replace(",", "."));
                       if (isNaN(v) || v <= 0 || v > maxim + 0.005) { e.preventDefault(); verifica(true); }
                     });
                     verifica(false);
                   })();
                   <\/script>`
                : `<p class="nota">Nu ai nimic de cerut acum${cerutLunaAsta > 0 ? ` — ai cerut deja ${lei(cerutLunaAsta)} luna asta` : ""}.
                     Ce se mai încasează până pe ${esc(f.seInchideLa)} se adaugă aici; ce rămâne necerut trece în ${numeLuna(lunaMinus(lunaAcum, -1))}.
                     ${
                       viitorTotal > 0
                         ? `Dacă îți trebuie bani acum, poți lua în avans până la <strong>${lei(
                             viitorTotal * (1 - RETINERE_AVANS / 100)
                           )}</strong> din facturile neîncasate — secțiunea „Ia comisionul mai devreme", mai jos.`
                         : ""
                     }</p>`
              : `<p class="nota">Butonul se deschide pe <strong>${esc(f.seDeschideLa)}</strong> și stă deschis până pe ${esc(f.seInchideLa)}.
                   Azi e ${esc(aziISO)}. Până atunci cifra de sus doar crește, pe măsură ce intră banii.</p>`
          }
          ${
            cereriLunaAsta.length
              ? `<div class="cereri-luna"><strong>Cerut luna asta:</strong>
                   ${cereriLunaAsta.map((c) => `<span class="badge gri">${lei(c.suma_ceruta)} · ${esc(String(c.creata_la || "").slice(0, 10))}</span>`).join(" ")}
                 </div>`
              : ""
          }
        </div>
      </div>

      <h2 style="margin-top:22px">Facturile din care iese comisionul lunii</h2>
      <details class="detail-box" style="margin:0 0 14px" ${cautaAdauga ? "open" : ""}>
        <summary style="cursor:pointer;font-weight:600">＋ Adaugă o factură la comisionul lunii</summary>
        <p class="explic" style="margin-top:10px">
          Caută clientul și alege factura. Apar doar facturile care n-au intrat niciodată în comisionul nimănui —
          fie n-au fost încasate, fie încasarea a mers la alt agent. Ce adaugi aici intră în baza lunii
          ${esc(numeLuna(lunaAcum))} cu valoarea ei fără TVA, iar factura nu va mai produce comision a doua oară
          când intră banii.
        </p>
        <form class="filtre" method="get" action="/crm/comision" style="margin-bottom:10px">
          ${esteAdmin ? `<input type="hidden" name="agent" value="${agentId}">` : ""}
          <input name="adauga" value="${esc(cautaAdauga)}" placeholder="Numele clientului (ex: rocast)" autofocus
                 style="min-width:280px;padding:7px 10px;border:1px solid var(--border);border-radius:6px">
          <button class="btn secondary" type="submit">Caută</button>
          ${cautaAdauga ? `<a class="link-btn" href="/crm/comision${esteAdmin ? `?agent=${agentId}` : ""}">renunță</a>` : ""}
        </form>
        ${
          !cautaAdauga
            ? ""
            : gasiteDeAdaugat.length
              ? table(
                  ["Factura", "Data", "Client", "Fără TVA", "Stare", "De ce se poate adăuga", ""],
                  gasiteDeAdaugat.map((x) => {
                    const rest = nr(x.total) - nr(x.platit);
                    const motiv = nr(x.platit) > 0
                      ? `încasată, dar comisionul a mers la ${esc(String(x.agent_curent || "nimeni"))}`
                      : "neîncasată încă";
                    return [
                      `<a href="/facturi/${x.id}">${esc(x.document_extern || `${x.serie || ""}${x.numar || ""}`)}</a>`,
                      esc(String(x.data_emiterii || "").slice(0, 10)),
                      esc(String(x.client || "—").slice(0, 40)),
                      `<strong>${lei(x.net)}</strong>`,
                      nr(x.platit) > 0 ? (rest > 1 ? `plătită parțial · rest ${lei(rest)}` : "plătită") : "neplătită",
                      `<span style="color:var(--text-muted)">${motiv}</span>`,
                      `<form method="post" action="/crm/comision/adauga" style="display:flex;gap:6px;align-items:center">
                         <input type="hidden" name="factura" value="${x.id}">
                         <input type="hidden" name="agent" value="${agentId}">
                         <input name="motiv" placeholder="de ce (opțional)" style="width:150px;padding:5px 7px;border:1px solid var(--border);border-radius:5px">
                         <button class="btn" type="submit">adaugă</button>
                       </form>`,
                    ];
                  })
                )
              : `<p class="nota">Niciun rezultat pentru „${esc(cautaAdauga)}". Ori clientul se scrie altfel, ori toate
                   facturile lui au intrat deja în comisionul cuiva.</p>`
        }
      </details>
      <p class="explic">
        Încasările intrate în ${numeLuna(lunaAcum)}, factură cu factură. Comisionul se dă din valoarea
        <strong>fără TVA</strong>: TVA-ul e banul statului, doar trece prin contul firmei.
        Pe fiecare rând: <code>bază fără TVA × ${pct}%</code>. Totalul coloanei e chiar cifra de sus.
      </p>
      ${
        bazaFacturi.length
          ? `<div class="toolbar" style="margin:0 0 10px">
               <input id="cautaFactura" type="search" autocomplete="off" placeholder="Caută după client sau număr de factură…"
                      style="min-width:320px;max-width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px">
               <span id="cateFacturi" style="margin-left:10px;color:var(--text-muted);font-size:13px">${bazaFacturi.length} ${
               bazaFacturi.length === 1 ? "factură" : "facturi"
             }</span>
             </div>
             <div id="cautaFacturiComision">` +
            table(
              ["Factura", "Data facturii", "Client", "Ultima încasare", "Cota mea", "Încasat (cu TVA)", "Bază (fără TVA)", "Comision"],
              bazaFacturi.map((x) => [
                `<a href="/facturi/${x.id}">${esc(x.document_extern || `${x.serie || ""}${x.numar || ""}`)}</a>${
                  nr(x.nr_plati) > 1 ? ` <span class="badge gri">${nr(x.nr_plati)} plăți</span>` : ""
                }${
                  x.manual
                    ? ` <span data-manual="${x.fel === "avans" ? "avans" : "adaugat"}" class="badge" style="background:${
                        x.fel === "avans" ? "var(--danger)" : "var(--warn,#c47f17)"
                      };color:#fff" title="${
                        x.fel === "avans"
                          ? `Avans din comisionul viitor. Baza brută ${money(nr(x.baza_bruta))}, reținere ${nr(x.retinere_pct)}%.`
                          : "Adăugată manual"
                      } de ${esc(String(x.adaugat_de_nume || "cineva"))} pe ${esc(
                        String(x.adaugat_la || "").slice(0, 10)
                      )}${x.motiv ? " · " + esc(String(x.motiv)) : ""}">${
                        x.fel === "avans" ? `avans −${nr(x.retinere_pct)}%` : "adăugată manual"
                      }</span>
                       <form method="post" action="/crm/comision/scoate" style="display:inline"
                             onsubmit="return confirm('Scoți factura din comisionul lunii?')">
                         <input type="hidden" name="id" value="${x.manual_id}">
                         <input type="hidden" name="agent" value="${agentId}">
                         <button class="link-btn" type="submit" title="Scoate din comision">scoate</button>
                       </form>`
                    : ""
                }`,
                esc(String(x.data_emiterii || "").slice(0, 10)),
                esc(String(x.client || "—").slice(0, 44)),
                esc(String(x.ultima_plata || "").slice(0, 10)),
                `${nr(x.cota_agent).toLocaleString("ro-RO")}%`,
                x.manual
                  ? `<span data-cv="inc" data-v="0" style="color:var(--text-muted)">${
                      x.fel === "avans" ? "luată în avans" : "neîncasată"
                    }</span>`
                  : `<span data-cv="inc" data-v="${nr(x.incasat_partea_mea)}">${lei(x.incasat_partea_mea)}</span>`,
                `<span data-cv="baza" data-v="${nr(x.baza)}">${lei(x.baza)}</span>`,
                `<strong data-cv="com" data-v="${nr(x.comision)}">${lei(x.comision)}</strong>`,
              ]),
              {
                total: [
                  `Total`,
                  "",
                  "",
                  "",
                  "",
                  `<span id="totIncasat">${lei(acum.incasat)}</span>`,
                  `<strong id="totBaza">${lei(bazaFacturiTotal)}</strong>`,
                  `<strong id="totComision">${lei(bazaFacturiComision)}</strong>`,
                ],
              }
            ) +
            `</div>` +
            (bazaSePotriveste
              ? ""
              : `<p class="nota" style="color:var(--danger)">Atenție: lista dă ${lei(bazaFacturiTotal)} bază, iar capul paginii
                   ${lei(acum.baza)}. Diferența de ${lei(Math.abs(bazaFacturiTotal - nr(acum.baza)))} înseamnă că undeva e o
                   încasare care nu se leagă de o factură alocată ție — spune-i lui Vali.</p>`) +
            CAUTARE_FACTURI
          : `<p class="nota">Luna asta n-a intrat încă niciun ban pe facturile tale. Când intră, apar aici una câte una.</p>`
      }

      <div class="cards">
        <div class="card"><div class="label">Comision viitor (facturi emise, neîncasate)</div><div class="value">${lei(viitorTotal)}</div>
          <div class="mic">${viitor.length} facturi · ${pct}% din partea ta din ce a mai rămas de încasat</div></div>
        <div class="card"><div class="label">Comision potențial (comenzi + lead-uri)</div><div class="value">${lei(potentialPonderat + comenziComision)}</div>
          <div class="mic">${lei(comenziComision)} din ${comenzi.length} ${comenzi.length === 1 ? "comandă în producție" : "comenzi în producție"}${
            comenziFaraTemei ? ` (${comenziFaraTemei} fără valoare, deci nesocotite)` : ""
          } · ${lei(potentialPonderat)} din ${potential.length} ${potential.length === 1 ? "oportunitate" : "oportunități"}</div></div>
        <div class="card"><div class="label">Încasat luna asta pe facturile mele</div><div class="value">${lei(acum.incasat)}</div>
          <div class="mic">cu TVA, cât a intrat efectiv în cont</div></div>
        <div class="card"><div class="label">Baza de comision a lunii</div><div class="value">${lei(acum.baza)}</div>
          <div class="mic">aceleași încasări, fără TVA — din asta iese comisionul</div></div>
      </div>

      <h2>Prognoza comisionului, după scadențe</h2>
      <p class="explic">
        Fiecare factură emisă și neîncasată aduce comision când intră banii. Aici sunt puse pe luna în care ar
        trebui să intre, după scadența lor. Formula pe fiecare factură:
        <code>(total − încasat, fără TVA) × cota ta din factură × ${pct}%</code>.
      </p>
      ${table(
        ["Când", "Facturi", "Comision așteptat"],
        cosuri.map((c) => [
          c.cheie === "restant" ? `<span class="badge rosu">${esc(c.eticheta)}</span>` : esc(c.eticheta),
          String(c.n),
          `<strong>${lei(c.suma)}</strong>`,
        ]),
        { total: ["Total", String(viitor.length), `<strong>${lei(viitorTotal)}</strong>`] }
      )}

      <h2 style="margin-top:22px">Ia comisionul mai devreme, din facturile neîncasate</h2>
      <p class="explic">
        Poți lua acum comisionul de pe facturi care încă n-au fost plătite — cel mult
        <strong>${lei(viitorTotal)}</strong>, adică tot ce ai de luat din facturile deja emise.
        Se reține <strong>${RETINERE_AVANS}%</strong> din suma luată în avans: firma scoate banul acum
        dintr-o factură care poate intra peste două luni, sau deloc.
        Bifezi facturile, iar comisionul lor intră în luna ${esc(numeLuna(lunaAcum))}.
        <strong>Facturile alese nu mai produc comision când intră banii</strong> — s-a plătit deja.
      </p>
      ${
        viitor.length
          ? `<form method="post" action="/crm/comision/avans" id="formAvans"
                   onsubmit="return confirm('Iei comisionul în avans pe facturile bifate? Ele nu vor mai produce comision când se încasează.')">
               <input type="hidden" name="agent" value="${agentId}">
               ${table(
                 ["", "Factura", "Client", "Scadența", "Rest de încasat", "Comision brut", `După reținerea de ${RETINERE_AVANS}%`],
                 viitor.map((x) => [
                   `<input type="checkbox" name="factura" value="${x.id}" class="bifaAvans" data-brut="${nr(x.comision)}">`,
                   `<a href="/facturi/${x.id}">${esc(x.document_extern || `${x.serie || ""}${x.numar || ""}`)}</a>`,
                   esc(String(x.partener || "—").slice(0, 34)),
                   esc(String(x.data_scadenta || x.data_emiterii || "").slice(0, 10)),
                   lei(x.rest),
                   lei(x.comision),
                   `<strong>${lei(x.comision * (1 - RETINERE_AVANS / 100))}</strong>`,
                 ]),
                 { total: ["", `${viitor.length} facturi`, "", "", "", `<strong>${lei(viitorTotal)}</strong>`, `<strong>${lei(viitorTotal * (1 - RETINERE_AVANS / 100))}</strong>`] }
               )}
               <div class="toolbar" style="margin-top:10px;align-items:center;gap:12px">
                 <button class="btn" type="submit">Ia în avans facturile bifate</button>
                 <span id="sumaAvans" style="color:var(--text-muted);font-size:13px">nimic bifat</span>
               </div>
             </form>
             <script>
             (function () {
               var f = document.getElementById("formAvans");
               if (!f) return;
               var et = document.getElementById("sumaAvans");
               var bife = [].slice.call(f.querySelectorAll(".bifaAvans"));
               function bani(v) {
                 return v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";
               }
               function socoteste() {
                 var brut = 0, n = 0;
                 for (var i = 0; i < bife.length; i++) {
                   if (bife[i].checked) { n++; brut += Number(bife[i].getAttribute("data-brut") || 0); }
                 }
                 et.textContent = n
                   ? n + (n === 1 ? " factură bifată · " : " facturi bifate · ") + bani(brut) + " brut, reținere " +
                     bani(brut * ${RETINERE_AVANS} / 100) + ", primești " + bani(brut * (1 - ${RETINERE_AVANS} / 100))
                   : "nimic bifat";
               }
               for (var i = 0; i < bife.length; i++) bife[i].addEventListener("change", socoteste);
               socoteste();
             })();
             <\/script>`
          : `<p class="nota">N-ai facturi emise și neîncasate, deci n-ai ce lua în avans.</p>`
      }

      <h2>Facturile din care vine comisionul viitor</h2>
      ${table(
        ["Factură", "Client", "Emisă", "Scadentă", "Total", "Încasat", "Rest", "Cota mea", "Comision"],
        viitor.slice(0, 100).map((x) => [
          `<a href="/facturi/${x.id}">${esc(String(x.serie || "") + String(x.numar || ""))}</a>`,
          esc(x.partener || "—"),
          esc(String(x.data_emiterii || "").slice(0, 10)),
          x.data_scadenta && String(x.data_scadenta).slice(0, 10) < aziISO
            ? `<span class="badge rosu">${esc(String(x.data_scadenta).slice(0, 10))}</span>`
            : esc(String(x.data_scadenta || "—").slice(0, 10)),
          lei(x.total),
          lei(x.platit),
          `<strong>${lei(x.rest)}</strong>`,
          `${nr(x.procent).toLocaleString("ro-RO")}%`,
          lei(x.comision),
        ])
      )}
      ${viitor.length > 100 ? `<p class="mic">Se arată primele 100 din ${viitor.length}.</p>` : ""}

      <h2>Comision din comenzile aflate în producție</h2>
      <p class="explic">
        Doar comenzile tale cu statusul <strong>În producție</strong>. Sunt câștigate — clientul a comandat — dar banii
        n-au intrat, deci comisionul din ele e încă o promisiune. Comenzile finalizate sau facturate rămân în
        Producție → Comenzi, dar nu mai apar aici: ele se văd la facturi, unde comisionul e deja real.
        Registrul de comenzi vine dintr-un Excel <strong>fără prețuri</strong>,
        așa că valoarea se ia în ordinea asta: <strong>cât ai scris tu pe comandă</strong>; dacă n-ai scris,
        <strong>media facturilor clientului</strong> din ultimul an; dacă nici asta nu se poate, comanda apare în listă
        dar nu se pune la socoteală. Valoarea o scrii din pagina comenzii, la „Valoare estimată".
      </p>
      ${
        comenzi.length
          ? table(
              ["Comanda", "Client", "Produs", "Cantitate", "Livrare", "Valoare", "De unde e valoarea", `Comision (${pct}%)`],
              comenzi.slice(0, 60).map((c) => [
                `<a href="/productie/${c.id}">${esc(c.numar || String(c.id))}</a>`,
                esc(c.client || "—"),
                esc(c.tip_produs || "—"),
                esc([c.cantitate, c.um].filter(Boolean).join(" ")),
                esc(c.data_livrare || "—"),
                c.valoare ? lei(c.valoare) : `<span class="mic">—</span>`,
                c.valoare ? `<span class="mic">${esc(c.temei)}</span>` : `<a class="mic" href="/productie/${c.id}">scrie o valoare</a>`,
                c.valoare ? `<strong>${lei(c.comision)}</strong>` : `<span class="mic">—</span>`,
              ]),
              { total: ["Total", "", "", "", "", lei(comenziValoare), "", `<strong>${lei(comenziComision)}</strong>`] }
            )
          : `<p class="mic">Nicio comandă nefacturată pe numele tău.</p>`
      }
      ${comenzi.length > 60 ? `<p class="mic">Se arată primele 60 din ${comenzi.length}.</p>` : ""}

      <h2>Comision potențial, din lead-urile deschise</h2>
      <p class="explic">
        Nu e bani, e speranță pusă în cifre. Formula: <code>valoare estimată × ${pct}% × șansa stadiului</code>.
        Șansele sunt cele uzuale de pipeline — lead 10%, calificat 25%, ofertă trimisă 50%, negociere 75% — și
        sunt scrise aici tocmai ca să știi că sunt o presupunere, nu o promisiune.
      </p>
      ${table(
        ["Oportunitate", "Client", "Stadiu", "Valoare estimată", "Comision dacă se câștigă", "Șansă", "Ponderat"],
        potential.slice(0, 60).map((o) => [
          `<a href="/crm/oportunitati/${o.id}">${esc(o.titlu)}</a>`,
          esc(o.partener || "—"),
          esc(o.stadiu),
          lei(o.valoare_estimata),
          lei(o.brut),
          `${Math.round(o.sansa * 100)}%`,
          `<strong>${lei(o.ponderat)}</strong>`,
        ]),
        { total: ["Total", "", "", lei(potential.reduce((s, o) => s + nr(o.valoare_estimata), 0)), lei(potentialBrut), "", `<strong>${lei(potentialPonderat)}</strong>`] }
      )}

      <h2>Istoricul, lună cu lună</h2>
      <p class="explic">
        „Report" e ce ai avut și n-ai cerut luna dinainte. „Câștigat" e ${pct}% din încasările lunii.
        „Disponibil la final" = report + câștigat − cerut, și el devine reportul lunii următoare.
        ${
          start === lunaAcum && !cereri.length
            ? `Reportul pornește din <strong>${numeLuna(lunaAcum)}</strong>: până acum nu s-a cerut nimic prin ERP,
               deci n-avem de unde ști ce s-a plătit deja pe alte căi. Lunile dinainte sunt doar istoric —
               cifrele lor nu se adună la ce ai de luat.`
            : `Reportul curge din <strong>${numeLuna(start)}</strong>, luna primei cereri făcute prin ERP.`
        }
      </p>
      ${table(
        ["Luna", "Încasat pe facturile mele", "Câștigat", "Report din luna dinainte", "Cerut", "Disponibil la final"],
        rand
          .slice()
          .reverse()
          .map((r) => [
            r.luna === lunaAcum ? `<strong>${esc(numeLuna(r.luna))}</strong>` : esc(numeLuna(r.luna)),
            lei(r.incasat),
            lei(r.castigat),
            lei(r.report),
            r.cerut ? lei(r.cerut) : "—",
            r.conteaza ? `<strong>${lei(r.disponibil)}</strong>` : `<span style="color:var(--text-muted)">${lei(r.castigat - r.cerut)} · istoric</span>`,
          ])
      )}

      <style>
        .com-sus { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:18px; align-items:stretch; }
        @media (max-width: 860px) { .com-sus { grid-template-columns:1fr; } }
        .com-mare, .com-cerere { background:#fff; border:1px solid var(--border); border-radius:8px; padding:16px 18px; }
        .com-mare .label, .com-cerere .label { font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; }
        .com-mare .suma { font-size:38px; font-weight:700; line-height:1.1; margin:6px 0 10px; }
        .com-mare .formula { font-size:13px; color:var(--text-muted); line-height:1.6; }
        .com-cerere .field { margin-top:10px; }
        .com-cerere .nota { font-size:12px; color:var(--text-muted); margin:10px 0 0; line-height:1.5; }
        .cereri-luna { margin-top:12px; font-size:13px; }
        .explic { margin:-6px 0 10px; color:var(--text-muted); font-size:13px; max-width:860px; line-height:1.6; }
        .mic { font-size:12px; color:var(--text-muted); }
        code { background:#f2f4f7; padding:1px 5px; border-radius:3px; font-size:12px; }
      </style>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comisionul meu", active: "/crm/comision", body }));
  });

  // Adaugă o factură la comisionul lunii curente. Poate și agentul, pe pagina
  // lui — rămâne scris cine a adăugat și când, iar linia se vede marcată în
  // listă, deci nimic nu se strecoară neobservat.
  router.post("/crm/comision/adauga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    const agentId = esteAdmin && nr(ctx.body.agent) ? nr(ctx.body.agent) : ctx.user.id;
    if (!esteAdmin && agentId !== ctx.user.id) return redirect(ctx.res, "/crm/comision");
    const inapoi = `/crm/comision${esteAdmin ? `?agent=${agentId}` : ""}`;
    const cuMesaj = (cheie, text) => `${inapoi}${esteAdmin ? "&" : "?"}${cheie}=${encodeURIComponent(text)}`;

    const facturaId = nr(ctx.body.factura);
    if (!facturaId) return redirect(ctx.res, cuMesaj("eroare", "N-am înțeles ce factură să adaug."));

    // Verificăm din nou aici tot ce verifica și căutarea. Între afișarea
    // listei și apăsarea butonului, factura poate să fi fost adăugată de
    // altcineva sau încasată.
    const f = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.status, f.directie, f.intercompany,
                COALESCE(n.net, 0) AS net, p.nume AS client
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN parteneri p ON p.id = f.partener_id
           LEFT JOIN ${cb.SUB_NET} n ON n.factura_id = f.id
          WHERE f.id = ?`
      )
      .get(facturaId);
    if (!f) return redirect(ctx.res, cuMesaj("eroare", "Factura nu există sau a fost ștearsă."));
    if (f.directie !== "vanzare" || ["anulata", "ciorna", "necunoscut"].includes(String(f.status)) || nr(f.intercompany))
      return redirect(ctx.res, cuMesaj("eroare", "Factura asta nu poate intra în comision."));
    // Zero înseamnă că lipsesc liniile. Negativ înseamnă storno — ăla e
    // valid și trebuie să se poată adăuga, ca să scadă comisionul lunii.
    // Condiția a fost întâi „> 0" și respingea tocmai stornourile.
    const baza = Math.round(nr(f.net) * 100) / 100;
    if (!baza)
      return redirect(ctx.res, cuMesaj("eroare", "Factura n-are valoare fără TVA în ERP (probabil îi lipsesc liniile), deci n-am din ce socoti comision."));

    const deja = await db.prepare("SELECT id FROM comision_manual WHERE factura_id = ? AND activ = 1").get(facturaId);
    if (deja) return redirect(ctx.res, cuMesaj("eroare", "Factura e deja adăugată la un comision."));
    const agentPt = await db.prepare("SELECT comision_procent FROM utilizatori WHERE id = ?").get(agentId);
    const pctAgent = nr(agentPt && agentPt.comision_procent);

    const numar = f.document_extern || `${f.serie || ""}${f.numar || ""}`;
    await db
      .prepare(
        `INSERT INTO comision_manual (utilizator_id, factura_id, luna, baza, motiv, adaugat_de, adaugat_la, activ)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(agentId, facturaId, lunaLui(azi()), baza, String(ctx.body.motiv || "").trim().slice(0, 200) || null, ctx.user.id, azi());
    return redirect(
      ctx.res,
      cuMesaj(
        "mesaj",
        baza < 0
          ? `${numar} (storno, ${money(baza)} fără TVA) a intrat în comisionul lunii și îl SCADE cu ${money(Math.abs((baza * pctAgent) / 100))}.`
          : `${numar} (${money(baza)} fără TVA) a intrat în comisionul lunii.`
      )
    );
  });

  // Avans din comisionul viitor. Agentul bifează facturi emise și neîncasate
  // și le încasează comisionul acum, cu o reținere de RETINERE_AVANS%.
  //
  // Mecanica e aceeași cu adăugarea manuală — o linie în comision_manual —
  // doar că baza scrisă e cea micșorată cu reținerea. Așa intră în luna
  // curentă exact cât primește, iar factura, având linie manuală, nu mai
  // produce comision când banii chiar intră. Fără partea asta, avansul s-ar
  // plăti de două ori.
  router.post("/crm/comision/avans", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    const agentId = esteAdmin && nr(ctx.body.agent) ? nr(ctx.body.agent) : ctx.user.id;
    if (!esteAdmin && agentId !== ctx.user.id) return redirect(ctx.res, "/crm/comision");
    const inapoi = `/crm/comision${esteAdmin ? `?agent=${agentId}` : ""}`;
    const cuMesaj = (cheie, text) => `${inapoi}${esteAdmin ? "&" : "?"}${cheie}=${encodeURIComponent(text)}`;

    const cerute = [].concat(ctx.body.factura || []).map((x) => nr(x)).filter(Boolean);
    if (!cerute.length) return redirect(ctx.res, cuMesaj("eroare", "N-ai bifat nicio factură."));

    const agent = await db.prepare("SELECT id, nume, comision_procent FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm/comision");
    const pct = nr(agent.comision_procent);
    if (!(pct > 0)) return redirect(ctx.res, cuMesaj("eroare", "Procentul tău de comision e 0, deci avansul ar fi zero."));

    // Recitim facturile din bază, nu ne bazăm pe ce a venit din formular:
    // între afișarea paginii și bifat, o factură poate fi încasată, stornată
    // sau luată deja în avans de altcineva.
    const eligibile = await facturiNeincasate(agentId);
    const dupaId = new Map(eligibile.map((x) => [Number(x.id), x]));
    const alese = cerute.map((id) => dupaId.get(id)).filter(Boolean);
    if (!alese.length)
      return redirect(ctx.res, cuMesaj("eroare", "Facturile bifate nu mai sunt disponibile — între timp s-au încasat sau au intrat deja în comision."));

    const lunaAcum = lunaLui(azi());
    const aziISO = azi();
    let brut = 0;
    let scrise = 0;
    for (const x of alese) {
      const rest = nr(x.total) - nr(x.platit);
      const restNet = rest * cb.raportNetJs(x.net, x.total, x.data_emiterii);
      const bazaBruta = Math.round(restNet * (nr(x.procent) / 100) * 100) / 100;
      if (!(bazaBruta > 0)) continue;
      const baza = Math.round(bazaBruta * (1 - RETINERE_AVANS / 100) * 100) / 100;
      const deja = await db.prepare("SELECT id FROM comision_manual WHERE factura_id = ? AND activ = 1").get(x.id);
      if (deja) continue;
      await db
        .prepare(
          `INSERT INTO comision_manual
             (utilizator_id, factura_id, luna, baza, baza_bruta, retinere_pct, fel, motiv, adaugat_de, adaugat_la, activ)
           VALUES (?, ?, ?, ?, ?, ?, 'avans', ?, ?, ?, 1)`
        )
        .run(agentId, x.id, lunaAcum, baza, bazaBruta, RETINERE_AVANS,
             `avans din comisionul viitor, reținere ${RETINERE_AVANS}%`, ctx.user.id, aziISO);
      brut += bazaBruta;
      scrise++;
    }
    if (!scrise) return redirect(ctx.res, cuMesaj("eroare", "Nicio factură bifată n-a putut fi luată în avans."));
    const retinut = Math.round(brut * (RETINERE_AVANS / 100) * 100) / 100;
    const primit = Math.round((brut - retinut) * 100) / 100;
    return redirect(
      ctx.res,
      cuMesaj(
        "mesaj",
        `${scrise} ${scrise === 1 ? "factură a intrat" : "facturi au intrat"} în avans: bază ${money(brut)}, reținere ${RETINERE_AVANS}% (${money(
          retinut
        )}), ți-au intrat ${money(primit)} în luna asta. Facturile nu mai produc comision la încasare.`
      )
    );
  });

  // Scoaterea nu șterge rândul, îl dezactivează: rămâne urma cine l-a pus,
  // cine l-a scos și când. La bani, istoricul contează mai mult decât un
  // tabel curat.
  router.post("/crm/comision/scoate", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    const agentId = esteAdmin && nr(ctx.body.agent) ? nr(ctx.body.agent) : ctx.user.id;
    const inapoi = `/crm/comision${esteAdmin ? `?agent=${agentId}` : ""}`;
    const cuMesaj = (cheie, text) => `${inapoi}${esteAdmin ? "&" : "?"}${cheie}=${encodeURIComponent(text)}`;
    const id = nr(ctx.body.id);
    const linie = await db.prepare("SELECT * FROM comision_manual WHERE id = ? AND activ = 1").get(id);
    if (!linie) return redirect(ctx.res, cuMesaj("eroare", "Linia nu mai există."));
    if (!esteAdmin && nr(linie.utilizator_id) !== ctx.user.id) return redirect(ctx.res, "/crm/comision");
    await db
      .prepare("UPDATE comision_manual SET activ = 0, scos_de = ?, scos_la = ? WHERE id = ?")
      .run(ctx.user.id, azi(), id);
    return redirect(ctx.res, cuMesaj("mesaj", "Factura a ieșit din comisionul lunii."));
  });

  router.post("/crm/comision/cerere", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    let agentId = ctx.user.id;
    if (esteAdmin && nr(ctx.body.agent)) agentId = nr(ctx.body.agent);
    const agent = await db.prepare("SELECT id, nume, email, comision_procent FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm/comision");

    const aziISO = azi();
    const lunaAcum = lunaLui(aziISO);
    const f = fereastra(aziISO);
    const inapoi = `/crm/comision${esteAdmin ? `?agent=${agentId}` : ""}`;
    const cuMesaj = (cheie, text) => `${inapoi}${esteAdmin ? "&" : "?"}${cheie}=${encodeURIComponent(text)}`;

    if (!f.deschisa) return redirect(ctx.res, cuMesaj("eroare", `Cererea se poate face doar între ${f.seDeschideLa} și ${f.seInchideLa}.`));

    // Recalculăm disponibilul aici, nu ne bazăm pe ce a venit din formular:
    // între afișarea paginii și apăsarea butonului poate să fi intrat o plată,
    // sau agentul poate să fi trimis de două ori.
    const pct = nr(agent.comision_procent);
    const primaLuna = lunaMinus(lunaAcum, 11);
    const luni = [];
    for (let i = 11; i >= 0; i--) luni.push(lunaMinus(lunaAcum, i));
    const cereriTot = await db.prepare("SELECT * FROM cereri_comision WHERE utilizator_id = ? ORDER BY luna").all(agentId);
    const rand = socoteala(luni, await bazaPeLuni(agentId, primaLuna), cereriTot, pct, startLedger(cereriTot, lunaAcum));
    const acum = rand[rand.length - 1];
    const disponibil = Math.round(acum.disponibil * 100) / 100;

    let suma = Math.round(nr(ctx.body.suma) * 100) / 100;
    if (!(suma > 0)) return redirect(ctx.res, cuMesaj("eroare", "Scrie o sumă mai mare decât zero."));
    if (suma > disponibil + 0.01)
      return redirect(
        ctx.res,
        cuMesaj(
          "eroare",
          `Ai disponibil ${money(disponibil)}, nu poți cere ${money(suma)}. ` +
            `Dacă îți trebuie mai mult, ia comisionul în avans din facturile neîncasate, din secțiunea „Ia comisionul mai devreme".`
        )
      );
    if (suma > disponibil) suma = disponibil;

    const r = await db
      .prepare(
        `INSERT INTO cereri_comision (utilizator_id, luna, baza, procent, disponibil, suma_ceruta, observatii, creata_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(agentId, lunaAcum, acum.baza, pct, disponibil, suma, String(ctx.body.observatii || "").trim() || null, aziISO);

    // Mailul către Vali. Dacă nu se poate trimite, cererea rămâne în bază —
    // banii nu depind de un server SMTP.
    let stare = "netrimis";
    try {
      const mail = require("../lib/mail");
      let exp = null;
      const candidati = [agentId];
      for (const u of await db
        .prepare("SELECT id FROM utilizatori WHERE activ = 1 AND smtp_host IS NOT NULL ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id")
        .all())
        candidati.push(u.id);
      for (const id of candidati) {
        const u = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(id);
        const cfg = u && mail.configUtilizator(u);
        if (cfg) { exp = cfg; break; }
      }
      if (!exp) stare = "fără cont de email configurat";
      else {
        const baza = (process.env.ERP_URL || "https://erp-cashmachine-app.onrender.com").replace(/\/$/, "");
        await mail.trimite(exp, {
          catre: [EMAIL_COMISION],
          subiect: `Cerere comision ${numeLuna(lunaAcum)} — ${agent.nume}: ${money(suma)}`,
          corp: [
            `${agent.nume} cere plata comisionului pe ${numeLuna(lunaAcum)}.`,
            ``,
            `Cere:        ${money(suma)}`,
            `Avea disponibil: ${money(disponibil)}`,
            `Rămâne:      ${money(disponibil - suma)} (se reportează în ${numeLuna(lunaMinus(lunaAcum, -1))})`,
            ``,
            `Din ce iese:`,
            `  încasat luna asta pe facturile lui: ${money(acum.incasat)} (cu TVA)`,
            `  baza de comision (fără TVA):        ${money(acum.baza)}`,
            `  procent comision:                   ${pct}%`,
            `  câștigat luna asta:                 ${money(acum.castigat)}`,
            `  report din ${numeLuna(lunaMinus(lunaAcum, 1))}: ${money(acum.report)}`,
            `  cerut anterior luna asta:           ${money(acum.cerut)}`,
            ctx.body.observatii ? `\nObservații: ${String(ctx.body.observatii).trim()}` : "",
            ``,
            `Pagina lui: ${baza}/crm/comision?agent=${agentId}`,
          ].join("\n"),
        });
        stare = "trimis";
      }
    } catch (e) {
      stare = "eroare la trimitere: " + e.message;
    }
    if (r.lastInsertRowid) await db.prepare("UPDATE cereri_comision SET email_stare = ? WHERE id = ?").run(stare, r.lastInsertRowid);

    const coada = stare === "trimis" ? "Mailul a plecat." : `Mailul n-a plecat (${stare}), dar cererea e înregistrată.`;
    redirect(ctx.res, cuMesaj("mesaj", `Cerere înregistrată: ${money(suma)}. ${coada}`));
  });
}

module.exports = { register, socoteala, fereastra };
