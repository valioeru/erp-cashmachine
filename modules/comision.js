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
      `SELECT SUBSTR(pl.data, 1, 7) AS luna, COALESCE(SUM(pl.suma * al.procent / 100.0), 0) AS incasat,
              COUNT(DISTINCT f.id) AS facturi
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0 AND al.utilizator_id = ? AND pl.data >= ?
        GROUP BY SUBSTR(pl.data, 1, 7)
        ORDER BY luna`
    )
    .all(agentId, deLaLuna + "-01");
}

// Facturile emise și neîncasate integral: comisionul care urmează să vină.
async function facturiNeincasate(agentId) {
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.data_emiterii, f.data_scadenta, p.nume AS partener,
              al.procent,
              COALESCE(t.total, 0) AS total,
              COALESCE(pl.platit, 0) AS platit
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         LEFT JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total
                      FROM facturi_linii GROUP BY factura_id) t ON t.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati
                     GROUP BY factura_id) pl ON pl.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna', 'necunoscut')
          AND f.intercompany = 0 AND al.utilizator_id = ?
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
        WHERE c.agent_id = ? AND c.status NOT IN ('anulata', 'facturata')
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
  const hCer = new Map();
  for (const c of cereri) hCer.set(c.luna, (hCer.get(c.luna) || 0) + nr(c.suma_ceruta));

  const rez = [];
  let report = 0;
  for (const luna of luni) {
    const conteaza = !startLedger || luna >= startLedger;
    const reportEfectiv = conteaza ? report : 0;
    const incasat = hInc.get(luna) || 0;
    const castigat = (incasat * pct) / 100;
    const cerut = hCer.get(luna) || 0;
    const disponibil = reportEfectiv + castigat - cerut;
    rez.push({ luna, incasat, castigat, cerut, report: reportEfectiv, disponibil, conteaza });
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

    const incasari = await incasariPeLuni(agentId, primaLuna);
    const cereri = await db.prepare("SELECT * FROM cereri_comision WHERE utilizator_id = ? ORDER BY luna").all(agentId);
    const start = startLedger(cereri, lunaAcum);
    const rand = socoteala(luni, incasari, cereri, pct, start);
    const acum = rand[rand.length - 1];
    const f = fereastra(aziISO);
    const cereriLunaAsta = cereri.filter((c) => c.luna === lunaAcum);
    const cerutLunaAsta = cereriLunaAsta.reduce((s, c) => s + nr(c.suma_ceruta), 0);

    // ---- comisionul viitor, din facturile neîncasate ----------------------
    const neincasate = await facturiNeincasate(agentId);
    const viitor = neincasate.map((x) => {
      const rest = nr(x.total) - nr(x.platit);
      return { ...x, rest, comision: (rest * nr(x.procent) / 100) * (pct / 100) };
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
            + ${pct}% din ${lei(acum.incasat)} încasați luna asta <strong>${lei(acum.castigat)}</strong>
            − cerut luna asta <strong>${lei(acum.cerut)}</strong>
          </div>
        </div>

        <div class="com-cerere">
          <div class="label">Cerere de plată</div>
          ${
            f.deschisa
              ? cerutMax > 0
                ? `<form method="post" action="/crm/comision/cerere">
                     <input type="hidden" name="agent" value="${agentId}">
                     <label class="field">Cât ceri (lei)
                       <input type="number" name="suma" min="0.01" max="${cerutMax}" step="0.01" value="${cerutMax}" required>
                     </label>
                     <label class="field">Observații (opțional)<input name="observatii" placeholder="ex: jumătate acum, restul luna viitoare"></label>
                     <button class="btn" type="submit">Cer plata comisionului</button>
                     <p class="nota">Poți cere și mai puțin — diferența îți rămâne și se reportează în ${numeLuna(lunaMinus(lunaAcum, -1))}.
                        Cererea pleacă pe mail la ${esc(EMAIL_COMISION)}.</p>
                   </form>`
                : `<p class="nota">Nu ai nimic de cerut acum${cerutLunaAsta > 0 ? ` — ai cerut deja ${lei(cerutLunaAsta)} luna asta` : ""}.
                     Ce se mai încasează până pe ${esc(f.seInchideLa)} se adaugă aici; ce rămâne necerut trece în ${numeLuna(lunaMinus(lunaAcum, -1))}.</p>`
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

      <div class="cards">
        <div class="card"><div class="label">Comision viitor (facturi emise, neîncasate)</div><div class="value">${lei(viitorTotal)}</div>
          <div class="mic">${viitor.length} facturi · ${pct}% din partea ta din ce a mai rămas de încasat</div></div>
        <div class="card"><div class="label">Comision potențial (comenzi + lead-uri)</div><div class="value">${lei(potentialPonderat + comenziComision)}</div>
          <div class="mic">${lei(comenziComision)} din ${comenzi.length} ${comenzi.length === 1 ? "comandă nefacturată" : "comenzi nefacturate"}${
            comenziFaraTemei ? ` (${comenziFaraTemei} fără valoare, deci nesocotite)` : ""
          } · ${lei(potentialPonderat)} din ${potential.length} ${potential.length === 1 ? "oportunitate" : "oportunități"}</div></div>
        <div class="card"><div class="label">Încasat luna asta pe facturile mele</div><div class="value">${lei(acum.incasat)}</div>
          <div class="mic">baza din care iese comisionul lunii</div></div>
      </div>

      <h2>Prognoza comisionului, după scadențe</h2>
      <p class="explic">
        Fiecare factură emisă și neîncasată aduce comision când intră banii. Aici sunt puse pe luna în care ar
        trebui să intre, după scadența lor. Formula pe fiecare factură:
        <code>(total − încasat) × cota ta din factură × ${pct}%</code>.
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

      <h2>Comision din comenzile nefacturate</h2>
      <p class="explic">
        Comenzile tale care încă n-au fost facturate. Sunt câștigate — clientul a comandat — dar banii n-au intrat,
        deci comisionul din ele e încă o promisiune. Registrul de comenzi vine dintr-un Excel <strong>fără prețuri</strong>,
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
    const rand = socoteala(luni, await incasariPeLuni(agentId, primaLuna), cereriTot, pct, startLedger(cereriTot, lunaAcum));
    const acum = rand[rand.length - 1];
    const disponibil = Math.round(acum.disponibil * 100) / 100;

    let suma = Math.round(nr(ctx.body.suma) * 100) / 100;
    if (!(suma > 0)) return redirect(ctx.res, cuMesaj("eroare", "Scrie o sumă mai mare decât zero."));
    if (suma > disponibil + 0.01)
      return redirect(ctx.res, cuMesaj("eroare", `Ai disponibil ${money(disponibil)}, nu poți cere ${money(suma)}.`));
    if (suma > disponibil) suma = disponibil;

    const r = await db
      .prepare(
        `INSERT INTO cereri_comision (utilizator_id, luna, baza, procent, disponibil, suma_ceruta, observatii, creata_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(agentId, lunaAcum, acum.incasat, pct, disponibil, suma, String(ctx.body.observatii || "").trim() || null, aziISO);

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
            `  încasat luna asta pe facturile lui: ${money(acum.incasat)}`,
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
