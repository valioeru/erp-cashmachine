"use strict";
// Fulfillment — comenzile Sameday, ambalate din stocul ținut acolo.
//
// ALTĂ GESTIUNE DECÂT CT-PARK, ȘI FIZIC ALT LOC. Vali, când l-am întrebat:
// „E complet diferit de ct-park, iese din depozit în altă zonă inclusiv
// fizic." De-aia marfa care pleacă din depozit spre fulfillment nu e o
// mutare de palet: paletul iese din CT-Park, iar aici intră o cantitate pe
// produs. Două gestiuni, două socoteli, un transfer între ele.
//
// CE REFOLOSEȘTE, ȘI DE CE. Comenzile nu se importă din nou aici. AWB-urile
// Sameday intră deja prin „Comenzi consumabile la zi" (modules/comenzi-zi.js),
// împreună cu toate capcanele lor rezolvate acolo: ultimele trei cifre ale
// AWB-ului sunt numărul coletului și eticheta fiecărui colet repetă comanda
// întreagă; ziua de raport e eticheta minus o zi; numele de pe etichetă nu e
// cel din nomenclator, deci recunoașterea merge pe nume, alias și semnătură.
// Un al doilea import, scris aici, ar fi fost un al doilea loc în care se pot
// pierde aceleași cifre. Pagina de aici CITEȘTE ce s-a importat și spune ce
// se poate expedia; butonul de import duce la importul care există.
//
// Regula de acoperire stă în lib/fulfillment.js, cu testul ei: o comandă nu
// pleacă pe jumătate, iar marfa unei comenzi blocate NU se rezervă — altfel
// o comandă oprită de un singur produs ar ține pe loc alte zece care erau
// gata. Comenzile vechi se servesc primele, ca să nu rămână niciuna la coadă
// la infinit.
const db = require("../lib/db");
const { esc, layout, table, money } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const F = require("../lib/fulfillment");

const nr = (v) => {
  const x = Number(v);
  return isFinite(x) ? x : 0;
};
const azi = () => new Date().toISOString().slice(0, 10);
const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const cant = (v) => nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const dataRo = (z) => {
  const p = String(z || "").slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(z || "");
};

const CALE = "/fulfillment";

function subtabs(activ) {
  const linkuri = [
    [CALE, "Comenzile zilei"],
    [`${CALE}/pending`, "În așteptare"],
    [`${CALE}/stoc`, "Stoc"],
    [`${CALE}/intrare`, "Intrare din depozit"],
    [`${CALE}/retururi`, "Retururi"],
  ];
  return `<div class="subnav" style="margin-top:-6px">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

function mesaje(q) {
  const ok = String((q && q.ok) || "");
  const er = String((q && q.eroare) || "");
  return (
    (er ? `<div class="detail-box" style="border-left:4px solid var(--danger);max-width:900px">${esc(er)}</div>` : "") +
    (ok ? `<div class="detail-box" style="border-left:4px solid #2f7d4f;max-width:900px">${esc(ok)}</div>` : "")
  );
}

// Stocul de fulfillment, adunat din mișcări. Nu există o coloană cu
// cantitatea curentă: o cifră care se scrie peste ea însăși nu se poate
// explica. Când cineva întreabă „de unde au apărut 300 de topuri aici",
// răspunsul trebuie să fie un rând cu data și documentul.
async function stocCurent() {
  const randuri = await db
    .prepare(
      `SELECT m.produs_id, SUM(m.cantitate) AS cantitate,
              p.denumire, p.cod, p.unitate_masura
         FROM ff_miscari m JOIN produse p ON p.id = m.produs_id
        GROUP BY m.produs_id, p.denumire, p.cod, p.unitate_masura
        ORDER BY p.denumire`
    )
    .all();
  const harta = new Map();
  for (const r of randuri) harta.set(Number(r.produs_id), nr(r.cantitate));
  return { randuri, harta };
}

// Comenzile unei zile, din AWB-urile deja importate, traduse în produse
// reale. `consumabile_produse.produs_id` e legătura făcută o dată, cu ochii,
// din pagina de comenzi la zi — de-aia un articol nelegat se vede aici ca
// atare, nu dispare: o comandă care cere ceva nelegat n-are cum fi verificată.
async function comenziZi(zile) {
  if (!zile.length) return [];
  const semne = zile.map(() => "?").join(",");
  const randuri = await db
    .prepare(
      `SELECT a.id AS awb_id, a.awb, a.kg, a.colete, z.data AS zi,
              COALESCE(c.nume, '—') AS client, c.oras,
              cp.id AS consumabil_id, cp.denumire AS denumire_eticheta, cp.produs_id,
              al.cantitate
         FROM consumabile_awb a
         JOIN consumabile_zile z ON z.id = a.zi_id
         LEFT JOIN consumabile_clienti c ON c.id = a.client_id
         LEFT JOIN consumabile_awb_linii al ON al.awb_id = a.id
         LEFT JOIN consumabile_produse cp ON cp.id = al.produs_id
        WHERE z.data IN (${semne})
        ORDER BY z.data, a.awb`
    )
    .all(...zile);

  const h = new Map();
  for (const r of randuri) {
    if (!h.has(r.awb)) {
      h.set(r.awb, { awb: r.awb, zi: String(r.zi).slice(0, 10), client: r.client, oras: r.oras, kg: nr(r.kg), colete: nr(r.colete), linii: [], nelegate: [] });
    }
    const c = h.get(r.awb);
    if (!r.consumabil_id) continue;
    if (r.produs_id) c.linii.push({ produs_id: Number(r.produs_id), denumire: r.denumire_eticheta, cantitate: nr(r.cantitate) });
    else c.nelegate.push({ denumire: r.denumire_eticheta, cantitate: nr(r.cantitate) });
  }
  return [...h.values()];
}

// Starea pe care o ținem noi, pe lângă ce scrie pe AWB.
async function stariDupaAwb(awburi) {
  if (!awburi.length) return new Map();
  const semne = awburi.map(() => "?").join(",");
  const r = await db.prepare(`SELECT * FROM ff_stare WHERE awb IN (${semne})`).all(...awburi);
  return new Map(r.map((x) => [x.awb, x]));
}

const ETICHETE_STARE = {
  noua: ['<span class="badge gri">nouă</span>', "abia importată"],
  acoperita: ['<span class="badge verde">are marfă</span>', "poate pleca azi"],
  lipsa: ['<span class="badge rosu">lipsește marfă</span>', "s-a cerut din depozit"],
  pregatita: ['<span class="badge verde">pregătită</span>', "scanată, gata de curier"],
  livrata: ['<span class="badge gri">livrată</span>', "a plecat"],
  anulata: ['<span class="badge gri">anulată</span>', ""],
  fara_linii: ['<span class="badge galben">fără articole</span>', "niciun produs recunoscut pe etichetă"],
};
const pastilaStare = (s) => (ETICHETE_STARE[s] || [`<span class="badge gri">${esc(String(s))}</span>`])[0];

function register(router) {
  // ---- Comenzile zilei --------------------------------------------------
  router.get(CALE, async (ctx) => {
    const zi = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.zi || "")) ? String(ctx.query.zi) : null;
    // Fără o zi aleasă: ultima zi care are AWB-uri importate. Pagina trebuie
    // să arate ceva când se deschide, nu un calendar gol.
    const ultima = await db.prepare("SELECT MAX(data) AS d FROM consumabile_zile").get();
    const ziua = zi || (ultima && ultima.d ? String(ultima.d).slice(0, 10) : azi());

    // Ziua curentă PLUS tot ce a rămas în urmă: comenzile neonorate nu se
    // mută în altă zi, rămân cu ziua lor și urcă în capul listei. Așa se
    // poate răspunde la „de câte zile stă asta" fără un istoric separat.
    const ramase = await db
      .prepare("SELECT DISTINCT zi FROM ff_stare WHERE stare IN ('noua','lipsa') AND zi < ? ORDER BY zi")
      .all(ziua);
    const zile = [...new Set([...ramase.map((r) => String(r.zi).slice(0, 10)), ziua])];

    const comenzi = await comenziZi(zile);
    const { harta, randuri: stocRanduri } = await stocCurent();
    const rez = F.acoperire(comenzi, harta, ziua);
    const stari = await stariDupaAwb(comenzi.map((c) => c.awb));
    const numeProdus = new Map(stocRanduri.map((r) => [Number(r.produs_id), r.denumire]));
    for (const l of comenzi.flatMap((c) => c.linii)) if (!numeProdus.has(l.produs_id)) numeProdus.set(l.produs_id, l.denumire);

    const ziInchisa = await db.prepare("SELECT * FROM ff_zile WHERE zi = ?").get(ziua);

    const randuriTabel = rez.comenzi.map((c) => {
      const s = stari.get(c.awb);
      // Starea scrisă de om (pregătită, livrată) bate socoteala de acoperire:
      // odată ambalată și scanată, comanda nu mai e „are marfă", e gata.
      const stare = s && ["pregatita", "livrata", "anulata"].includes(s.stare) ? s.stare : c.stare;
      const lipsaText = c.lipsa
        .map((l) => `${esc(numeProdus.get(l.produs_id) || "produs " + l.produs_id)}: lipsesc <strong>${cant(l.lipsa)}</strong>`)
        .join("<br>");
      return [
        `<code>${esc(c.awb)}</code>`,
        esc(c.client || "—") + (c.oras ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(c.oras)}</span>` : ""),
        dataRo(c.zi) + (c.intarziere ? ` <span class="badge rosu" style="font-size:10px">+${c.intarziere} ${c.intarziere === 1 ? "zi" : "zile"}</span>` : ""),
        String(c.linii.length) + (c.nelegate.length ? ` <span class="badge galben" style="font-size:10px">${c.nelegate.length} nelegate</span>` : ""),
        pastilaStare(stare),
        lipsaText || '<span style="color:var(--text-muted)">—</span>',
      ];
    });

    const body = `
      ${subtabs(CALE)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Comenzile zilei ${dataRo(ziua)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:980px">
        Comenzile vin din AWB-urile Sameday importate în
        <a href="/rapoarte/comenzi-la-zi">Comenzi consumabile la zi</a> — acolo se face și importul, ca să nu
        existe două drumuri pentru aceleași cifre. Aici se verifică dacă avem marfa în fulfillment.
        <strong>O comandă nu pleacă pe jumătate</strong>: dacă un singur produs lipsește, stă toată.
        Marfa ei NU se rezervă — rămâne liberă pentru comenzile care chiar pot pleca azi, altfel una blocată
        ar ține pe loc zece care erau gata.
      </p>

      <form class="filtre" method="get" action="${CALE}" style="margin-bottom:10px">
        <label>Ziua <input type="date" name="zi" value="${esc(ziua)}"></label>
        <button class="btn secondary small" type="submit">Arată</button>
        <a class="btn secondary small" href="/rapoarte/comenzi-la-zi">Importă AWB-uri →</a>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Comenzi</div><div class="value">${rez.comenzi.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">${zile.length > 1 ? `din ${zile.length} zile, cu restanțe` : "ziua asta"}</div></div>
        <div class="card"><div class="label">Pot pleca</div><div class="value" style="color:#2f7d4f">${rez.acoperite.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">au toată marfa</div></div>
        <div class="card"><div class="label">Blocate</div><div class="value" style="color:${rez.blocate.length ? "var(--danger)" : "inherit"}">${rez.blocate.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">lipsește cel puțin un produs</div></div>
        ${rez.fara_linii.length ? `<div class="card"><div class="label">Fără articole</div><div class="value" style="color:var(--warn)">${rez.fara_linii.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">nimic recunoscut pe etichetă</div></div>` : ""}
      </div>

      ${
        rez.totul_verde
          ? `<div class="detail-box" style="border-left:4px solid #2f7d4f;max-width:900px;margin-top:14px">
               <strong>Totul verde.</strong> Toate cele ${rez.acoperite.length} comenzi au marfa în fulfillment.
               Nu e nimic de cerut din depozit.
             </div>`
          : ""
      }

      ${
        rez.lipsuri.length
          ? `<h2>Ce trebuie cerut din depozit</h2>
             <p style="font-size:13px;color:var(--text-muted);max-width:900px;margin:0 0 8px">
               Cifrele de aici sunt <strong>diferența</strong>, nu tot ce cer comenzile: s-a scăzut întâi ce
               pleacă azi, apoi ce a mai rămas pe raft. Două comenzi blocate pe același produs cer o singură
               dată cât lipsește — altfel am cere marfă pe care o avem.
             </p>
             ${table(
               ["Produs", "Lipsește", "Avem acum"],
               rez.lipsuri.map((l) => [
                 esc(numeProdus.get(l.produs_id) || "produs " + l.produs_id),
                 `<strong>${cant(l.cantitate)}</strong>`,
                 cant(harta.get(l.produs_id) || 0),
               ])
             )}`
          : ""
      }

      <h2>Comenzile</h2>
      ${
        rez.comenzi.length
          ? table(["AWB", "Client", "Ziua", "Articole", "Stare", "Ce lipsește"], randuriTabel)
          : `<p>Nicio comandă importată pe ${dataRo(ziua)}. <a href="/rapoarte/comenzi-la-zi">Importă AWB-urile</a>.</p>`
      }

      ${
        ziInchisa && ziInchisa.inchisa_la
          ? `<p style="margin-top:14px;color:var(--text-muted);font-size:13px">Ziua a fost închisă la
               ${esc(String(ziInchisa.inchisa_la).slice(0, 16))}: ${nr(ziInchisa.comenzi_pregatite)} pregătite,
               ${nr(ziInchisa.comenzi_ramase)} rămase.${ziInchisa.observatii ? " " + esc(ziInchisa.observatii) : ""}</p>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Fulfillment", active: CALE, body }));
  });

  // ---- Ce stă în urmă ---------------------------------------------------
  router.get(`${CALE}/pending`, async (ctx) => {
    const ziua = azi();
    const stari = await db
      .prepare("SELECT * FROM ff_stare WHERE stare IN ('noua','lipsa') ORDER BY zi, awb")
      .all();
    const comenzi = await comenziZi([...new Set(stari.map((s) => String(s.zi).slice(0, 10)))]);
    const dupaAwb = new Map(comenzi.map((c) => [c.awb, c]));
    const { harta } = await stocCurent();

    const randuri = stari.map((s) => {
      const c = dupaAwb.get(s.awb);
      const zile = F.zileIntarziere(s.zi, ziua);
      const lipsa = c
        ? F.acoperire([c], harta, ziua).comenzi[0].lipsa.length
        : 0;
      return [
        `<code>${esc(s.awb)}</code>`,
        c ? esc(c.client || "—") : "—",
        dataRo(s.zi),
        zile ? `<strong style="color:${zile > 2 ? "var(--danger)" : "inherit"}">${zile}</strong>` : "0",
        pastilaStare(s.stare),
        esc(s.observatii || ""),
      ];
    });

    const body = `
      ${subtabs(`${CALE}/pending`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">În așteptare</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
        Comenzile neonorate nu se mută în altă zi și nu se șterg: rămân cu ziua lor, cu AWB-ul lor, și urcă
        în capul listei pe măsură ce îmbătrânesc. Coloana „Zile" e vechimea față de azi.
      </p>
      ${randuri.length ? table(["AWB", "Client", "Din ziua", "Zile", "Stare", "Observații"], randuri) : "<p>Nu stă nimic în urmă.</p>"}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Fulfillment — în așteptare", active: CALE, body }));
  });

  // ---- Stocul din fulfillment -------------------------------------------
  router.get(`${CALE}/stoc`, async (ctx) => {
    const { randuri } = await stocCurent();
    const ultimele = await db
      .prepare(
        `SELECT m.*, p.denumire FROM ff_miscari m JOIN produse p ON p.id = m.produs_id
          ORDER BY m.data DESC, m.id DESC LIMIT 40`
      )
      .all();

    const FELURI = {
      intrare_depozit: "din depozit",
      consum_comanda: "pe o comandă",
      retur: "retur",
      corectie: "corecție",
    };

    const body = `
      ${subtabs(`${CALE}/stoc`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Stoc în fulfillment</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
        Gestiune separată de CT-Park, și fizic alt loc. Cifrele de aici nu se scriu nicăieri ca atare:
        se adună din mișcări, ca la orice întrebare de felul „de unde au apărut astea" să existe un rând cu
        data și documentul, nu doar o cantitate.
      </p>
      ${
        randuri.length
          ? table(
              ["Produs", "Cod", "Cantitate", "UM"],
              randuri.map((r) => [
                esc(r.denumire),
                esc(r.cod || "—"),
                `<strong style="color:${nr(r.cantitate) < 0 ? "var(--danger)" : "inherit"}">${cant(r.cantitate)}</strong>`,
                esc(r.unitate_masura || ""),
              ])
            )
          : `<p>Nu e nimic în fulfillment. <a href="${CALE}/intrare">Adu marfă din depozit</a>.</p>`
      }
      ${randuri.some((r) => nr(r.cantitate) < 0) ? `<p style="color:var(--danger);font-size:13px">Un stoc negativ nu e o cantitate, e o greșeală de operare — se vede aici tocmai ca s-o poată repara cineva.</p>` : ""}

      <h2 style="margin-top:22px">Ultimele mișcări</h2>
      ${
        ultimele.length
          ? table(
              ["Data", "Produs", "Cantitate", "Fel", "Referință"],
              ultimele.map((m) => [
                dataRo(m.data),
                esc(m.denumire),
                `<strong style="color:${nr(m.cantitate) < 0 ? "var(--danger)" : "#2f7d4f"}">${nr(m.cantitate) > 0 ? "+" : ""}${cant(m.cantitate)}</strong>`,
                esc(FELURI[m.fel] || m.fel),
                esc([m.referinta, m.awb].filter(Boolean).join(" · ") || "—"),
              ])
            )
          : "<p>Nicio mișcare încă.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Stoc fulfillment", active: CALE, body }));
  });

  // ---- Intrare din depozit ----------------------------------------------
  //
  // Transferul care mută marfa dintr-o gestiune în alta. Din CT-Park iese un
  // palet (sau o parte din el), în fulfillment intră o cantitate pe produs.
  router.get(`${CALE}/intrare`, async (ctx) => {
    const paleti = await db
      .prepare(
        `SELECT p.id, p.cod, p.cantitate, p.um, p.lot, p.data_intrare, p.produs_id,
                COALESCE(pr.denumire, p.produs_text, 'marfă') AS nume,
                (SELECT STRING_AGG(l.adresa, ', ' ORDER BY l.adresa) FROM ct_ocupari o
                   JOIN ct_locuri l ON l.id = o.loc_id WHERE o.palet_id = p.id) AS adrese
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.data_iesire IS NULL AND p.produs_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM ct_ocupari o WHERE o.palet_id = p.id)
          ORDER BY p.data_intrare, p.id LIMIT 200`
      )
      .all();

    const body = `
      ${subtabs(`${CALE}/intrare`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Adu marfă din depozit</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
        Fulfillment e altă gestiune, și fizic alt loc, deci asta <strong>nu e o mutare de palet</strong>:
        paletul iese din CT-Park, locurile lui se eliberează, iar aici intră o cantitate pe produs.
        Dacă aduci doar o parte, paletul rămâne în depozit cu restul.
      </p>
      ${
        paleti.length
          ? `<form class="form" method="post" action="${CALE}/intrare" style="max-width:860px">
               <label class="field">Paletul
                 <select name="palet_id" required>
                   <option value="">— alege —</option>
                   ${paleti
                     .map(
                       (p) =>
                         `<option value="${p.id}">${esc(p.nume)} · ${cant(p.cantitate)} ${esc(p.um || "")}${p.lot ? " · lot " + esc(p.lot) : ""} · ${esc(p.adrese || "")}</option>`
                     )
                     .join("")}
                 </select>
               </label>
               <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
                 <label class="field">Cât aduci
                   <input type="number" name="cantitate" min="0" step="0.001" placeholder="gol = tot paletul">
                 </label>
                 <label class="field">Observații<input name="observatii" placeholder="ex. pentru comenzile de marți"></label>
               </div>
               <div class="form-actions"><button class="btn" type="submit">Adu în fulfillment</button></div>
             </form>`
          : `<p>Nu e niciun palet în CT-Park legat de un produs din nomenclator.
               Un palet cu denumirea scrisă liber nu poate fi adus aici: fără produs, stocul de fulfillment
               n-ar avea cu ce potrivi comenzile.</p>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Intrare în fulfillment", active: CALE, body }));
  });

  router.post(`${CALE}/intrare`, async (ctx) => {
    const b = ctx.body || {};
    const inapoi = (fel, text) => redirect(ctx.res, `${CALE}/intrare?${fel}=${encodeURIComponent(text)}`);
    const palet = await db
      .prepare(
        `SELECT p.*, COALESCE(pr.denumire, p.produs_text, 'marfă') AS nume
           FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.id = ? AND p.data_iesire IS NULL`
      )
      .get(nr(b.palet_id));
    if (!palet) return inapoi("eroare", "Paletul nu mai e în depozit.");
    if (!palet.produs_id) return inapoi("eroare", "Paletul n-are produs din nomenclator, deci n-am cu ce potrivi comenzile.");

    const peP = nr(palet.cantitate);
    const cere = nr(b.cantitate);
    const cat = cere > 0 ? Math.min(cere, peP) : peP;
    if (!(cat > 0)) return inapoi("eroare", "Paletul n-are cantitate scrisă pe el. Completeaz-o întâi în CT-Park.");
    if (cere > peP + 1e-9)
      return inapoi("eroare", `Pe palet sunt ${cant(peP)} ${palet.um || ""}, nu ${cant(cere)}. Adu cel mult cât e pe el.`);

    const tot = cat + 1e-9 >= peP;
    const data = azi();
    await db
      .prepare(
        `INSERT INTO ff_miscari (produs_id, cantitate, fel, referinta, palet_id, data, creat_de, observatii)
         VALUES (?, ?, 'intrare_depozit', ?, ?, ?, ?, ?)`
      )
      .run(
        palet.produs_id,
        cat,
        `palet ${palet.cod}`,
        palet.id,
        data,
        ctx.user ? ctx.user.id : null,
        String(b.observatii || "").slice(0, 300) || null
      );

    if (tot) {
      // Paletul întreg pleacă: iese din depozit și își eliberează locurile.
      // Nu se șterge — istoria lui (data intrării, prețul, lotul) rămâne.
      //
      // Unde a plecat se scrie în `ct_iesiri`, nu pe paletă: acolo e locul
      // în care CT-Park ține ieșirile, cu destinație, dată și cine a făcut-o.
      // Un palet care dispare din rafturi fără un rând de ieșire e exact
      // felul de gaură care se descoperă la inventar, peste trei luni.
      await db.prepare("UPDATE ct_paleti SET data_iesire = ? WHERE id = ?").run(data, palet.id);
      await db
        .prepare(
          `INSERT INTO ct_iesiri (palet_id, destinatie, client, data, observatii, creat_de)
           VALUES (?, 'fulfillment', NULL, ?, ?, ?)`
        )
        .run(
          palet.id,
          data,
          `transfer în gestiunea de fulfillment${String(b.observatii || "").trim() ? " — " + String(b.observatii).trim().slice(0, 200) : ""}`,
          ctx.user ? String(ctx.user.nume || ctx.user.id) : null
        );
      await db.prepare("DELETE FROM ct_ocupari WHERE palet_id = ?").run(palet.id);
    } else {
      // Parțial: paletul rămâne pe locul lui, cu restul.
      await db.prepare("UPDATE ct_paleti SET cantitate = ? WHERE id = ?").run(Math.round((peP - cat) * 1e6) / 1e6, palet.id);
    }

    return redirect(
      ctx.res,
      `${CALE}/stoc?ok=${encodeURIComponent(
        `${cant(cat)} ${palet.um || ""} ${palet.nume} ${tot ? "— paletul a ieșit din depozit" : `— pe palet mai rămân ${cant(peP - cat)}`}.`
      )}`
    );
  });
  // ---- Retururi ----------------------------------------------------------
  //
  // „Tot aici sosesc retururi, ar trebui să le scanăm și să te întrebe ce
  // face cu acea marfă."
  //
  // Două momente, nu unul. Scanarea spune DOAR că a sosit ceva — atât știe
  // omul în clipa aia. Decizia vine după ce deschide coletul. Între ele,
  // returul există ca rând în așteptare: dacă scanarea ar scrie direct în
  // stoc, marfa deteriorată ar intra în stocul bun și ar fi promisă unei
  // comenzi pe care n-o poate onora.
  router.get(`${CALE}/retururi`, async (ctx) => {
    const deDecis = await db
      .prepare(
        `SELECT r.*, p.denumire, p.unitate_masura FROM ff_retururi r
           LEFT JOIN produse p ON p.id = r.produs_id
          WHERE r.stare = 'de_decis' ORDER BY r.scanat_la DESC, r.id DESC`
      )
      .all();
    const rezolvate = await db
      .prepare(
        `SELECT r.*, p.denumire FROM ff_retururi r LEFT JOIN produse p ON p.id = r.produs_id
          WHERE r.stare <> 'de_decis' ORDER BY r.decis_la DESC, r.id DESC LIMIT 30`
      )
      .all();
    const produse = await db
      .prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE COALESCE(activ,1) = 1 ORDER BY denumire LIMIT 500")
      .all();

    const selectProdus = (nume, val) =>
      `<select name="${nume}" required><option value="">— alege produsul —</option>${produse
        .map((p) => `<option value="${p.id}"${String(val || "") === String(p.id) ? " selected" : ""}>${esc(p.denumire)}${p.cod ? " · " + esc(p.cod) : ""}</option>`)
        .join("")}</select>`;

    const body = `
      ${subtabs(`${CALE}/retururi`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Retururi</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:980px">
        Scanezi AWB-ul coletului întors — atât știi în clipa aia. Decizia vine după ce-l deschizi:
        marfa bună intră înapoi în stocul de fulfillment, cea stricată iese din gestiune
        <strong>cu poză</strong>. Nu din birocrație: marfa scoasă fără nicio dovadă e exact rândul pe care-l
        caută un control, iar singurul moment în care poza se poate face e cât coletul e încă pe masă.
      </p>

      <form class="form" method="post" action="${CALE}/retururi/scan" style="max-width:620px;margin-bottom:18px">
        <label class="field">Scanează AWB-ul returului
          <input name="awb" id="awb-retur" autofocus autocomplete="off" placeholder="scanează sau scrie AWB-ul"
                 style="font-size:18px;font-family:ui-monospace,monospace" required>
        </label>
        <div class="form-actions"><button class="btn" type="submit">A sosit</button></div>
      </form>
      ${/* Cititorul „tastează" codul și dă Enter. Formularul are un singur
           câmp, deci Enter îl trimite singur — nu trebuie apăsat butonul.
           Câmpul se refocalizează după fiecare trimitere, ca omul să poată
           scana colet după colet fără să atingă ecranul. */ ""}
      <script>
        (function () {
          var c = document.getElementById("awb-retur");
          if (c) { c.focus(); document.addEventListener("click", function (ev) {
            // Nu fura focusul din formularele de decizie de mai jos.
            if (ev.target.closest && ev.target.closest("form") !== c.form) return;
            c.focus();
          }); }
        })();

        // Poza, micsorata in browser inainte sa plece.
        //
        // DE CE AICI SI NU PE SERVER. Discul de pe Render e efemer: la
        // urmatorul restart, orice fisier scris pe el dispare, iar dovada
        // pentru marfa scoasa din gestiune ar fi exact ce lipseste cand se
        // uita cineva peste ea. Deci poza merge in baza de date. Dar o poza
        // de telefon are 3-5 MB, si cateva sute de retururi ar umfla baza
        // degeaba: la 1600px si JPEG 0.7 se vede perfect ce e stricat, si
        // ocupa 200-400 KB.
        //
        // Daca JS-ul nu merge, campul de fisier ramane acolo si serverul
        // primeste poza intreaga — se taie la 4 MB si se spune daca e prea
        // mare. Mai bine o cale mai proasta decat niciuna.
        (function () {
          var LATURA = 1600, CALITATE = 0.7;
          document.addEventListener("change", function (ev) {
            var inp = ev.target;
            if (!inp.classList || !inp.classList.contains("poza-retur")) return;
            var f = inp.files && inp.files[0];
            var camp = inp.parentNode.querySelector(".poza-date");
            var stare = inp.parentNode.querySelector(".poza-stare");
            if (!f || !camp) return;
            stare.textContent = "pregătesc poza…";
            var img = new Image();
            img.onload = function () {
              var s = Math.min(1, LATURA / Math.max(img.width, img.height));
              var cv = document.createElement("canvas");
              cv.width = Math.round(img.width * s);
              cv.height = Math.round(img.height * s);
              cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
              try {
                camp.value = cv.toDataURL("image/jpeg", CALITATE);
                stare.textContent = "poza e gata (" + Math.round(camp.value.length / 1365) + " KB)";
                // Golim campul de fisier: poza pleaca prin campul ascuns,
                // iar altfel ar pleca de doua ori, o data micsorata si o
                // data intreaga.
                inp.value = "";
              } catch (e) {
                stare.textContent = "n-am putut micșora poza, o trimit întreagă";
              }
              URL.revokeObjectURL(img.src);
            };
            img.onerror = function () { stare.textContent = "fișierul ăsta nu e o poză"; };
            img.src = URL.createObjectURL(f);
          });
        })();
      </script>

      <h2>Așteaptă decizia (${deDecis.length})</h2>
      ${
        deDecis.length
          ? deDecis
              .map(
                (r) => `<form class="form" method="post" action="${CALE}/retururi/${r.id}/decide"
                              enctype="multipart/form-data" style="max-width:980px;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
                  <div style="font-size:15px;font-weight:600;margin-bottom:8px">
                    <code>${esc(r.awb || "fără AWB")}</code>
                    <span style="font-weight:400;font-size:12px;color:var(--text-muted)">· scanat ${esc(String(r.scanat_la).slice(0, 16))}</span>
                  </div>
                  <div style="display:grid;grid-template-columns:3fr 1fr;gap:12px">
                    <label class="field">Ce s-a întors${selectProdus("produs_id", r.produs_id)}</label>
                    <label class="field">Cantitate<input type="number" name="cantitate" min="0" step="0.001" value="${r.cantitate || ""}" required></label>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
                    <label class="card-filtru" style="display:flex;gap:8px;align-items:flex-start;padding:10px;cursor:pointer">
                      <input type="radio" name="stare" value="in_stoc" checked>
                      <span><strong>E bună</strong><br><span style="font-size:12px;color:var(--text-muted)">intră înapoi în stocul de fulfillment</span></span>
                    </label>
                    <label class="card-filtru" style="display:flex;gap:8px;align-items:flex-start;padding:10px;cursor:pointer">
                      <input type="radio" name="stare" value="deteriorat">
                      <span><strong>E deteriorată</strong><br><span style="font-size:12px;color:var(--text-muted)">iese din gestiune — cere poză și motiv</span></span>
                    </label>
                  </div>
                  <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                    <label class="field">Ce are (doar la deteriorată)<input name="motiv" placeholder="strivit, udat, lipsă din colet"></label>
                    <label class="field">Poza
                      ${/* capture="environment" deschide direct camera din
                           spate pe telefon sau pe terminalul Android, în loc
                           de galerie: poza se face pe loc, nu se caută una
                           veche. Pe calculator, același câmp e un selector
                           de fișier obișnuit. */ ""}
                      <input type="file" class="poza-retur" accept="image/*" capture="environment">
                      <input type="hidden" name="poza_cale" class="poza-date">
                      <span class="poza-stare" style="font-size:11px;color:var(--text-muted)"></span>
                    </label>
                  </div>
                  <div class="form-actions"><button class="btn" type="submit">Salvează decizia</button></div>
                </form>`
              )
              .join("")
          : "<p>Niciun retur în așteptare.</p>"
      }

      <h2 style="margin-top:22px">Rezolvate recent</h2>
      ${
        rezolvate.length
          ? table(
              ["AWB", "Produs", "Cantitate", "Ce s-a făcut", "Motiv", "Poză", "Când"],
              rezolvate.map((r) => [
                `<code>${esc(r.awb || "—")}</code>`,
                esc(r.denumire || "—"),
                cant(r.cantitate),
                r.stare === "in_stoc"
                  ? '<span class="badge verde">înapoi în stoc</span>'
                  : '<span class="badge rosu">deteriorată, scoasă</span>',
                esc(r.motiv || "—"),
                r.poza
                  ? `<a href="${esc(r.poza)}" target="_blank"><img src="${esc(r.poza)}" alt="poza returului" style="height:38px;border-radius:3px;border:1px solid var(--border)"></a>`
                  : "—",
                esc(String(r.decis_la || "").slice(0, 16)),
              ])
            )
          : "<p>Încă niciunul.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Retururi fulfillment", active: CALE, body }));
  });

  router.post(`${CALE}/retururi/scan`, async (ctx) => {
    const awb = String((ctx.body || {}).awb || "").trim().slice(0, 60);
    const inapoi = (fel, text) => redirect(ctx.res, `${CALE}/retururi?${fel}=${encodeURIComponent(text)}`);
    if (!awb) return inapoi("eroare", "N-am primit niciun AWB.");

    // Dacă AWB-ul e cunoscut, aducem produsul și cantitatea de pe comanda
    // lui: de cele mai multe ori se întoarce exact ce s-a trimis, iar
    // operatorul doar confirmă. Dacă nu e cunoscut, returul se scrie oricum
    // — un colet venit pe un AWB străin tot a sosit, și trebuie să se vadă.
    const expeditia = String(awb).length > 3 ? String(awb).slice(0, -3) : awb;
    const linie = await db
      .prepare(
        `SELECT cp.produs_id, al.cantitate FROM consumabile_awb a
           JOIN consumabile_awb_linii al ON al.awb_id = a.id
           JOIN consumabile_produse cp ON cp.id = al.produs_id
          WHERE a.awb IN (?, ?) AND cp.produs_id IS NOT NULL
          ORDER BY al.cantitate DESC LIMIT 1`
      )
      .get(awb, expeditia);

    await db
      .prepare(
        `INSERT INTO ff_retururi (awb, produs_id, cantitate, stare, scanat_la, scanat_de)
         VALUES (?, ?, ?, 'de_decis', ?, ?)`
      )
      .run(awb, linie ? linie.produs_id : null, linie ? nr(linie.cantitate) : null, acum(), ctx.user ? ctx.user.id : null);

    return inapoi(
      "ok",
      linie
        ? `Returul ${awb} a fost înregistrat, cu ce scria pe comanda lui. Verifică și alege ce faci cu marfa.`
        : `Returul ${awb} a fost înregistrat. Nu cunosc AWB-ul ăsta, deci spune tu ce s-a întors.`
    );
  });

  router.post(`${CALE}/retururi/:id/decide`, async (ctx) => {
    const b = ctx.body || {};
    const inapoi = (fel, text) => redirect(ctx.res, `${CALE}/retururi?${fel}=${encodeURIComponent(text)}`);
    const r = await db.prepare("SELECT * FROM ff_retururi WHERE id = ?").get(ctx.params.id);
    if (!r) return inapoi("eroare", "Returul nu există.");
    if (r.stare !== "de_decis") return inapoi("eroare", "Returul ăsta a fost deja rezolvat.");

    // Poza vine fie micșorată din browser (câmpul ascuns), fie întreagă, ca
    // fișier, dacă JS-ul n-a mers. A doua cale se taie la 4 MB: nu ca să
    // economisim, ci fiindcă o bază umflată cu poze de 5 MB devine lentă
    // pentru toată lumea, iar dovada se vede la fel de bine și micșorată.
    const MAX = 4 * 1024 * 1024;
    let poza = String(b.poza_cale || "").trim();
    const fisier = (b.__files && b.__files.poza && b.__files.poza[0]) || null;
    if (!poza && fisier && fisier.data && fisier.data.length) {
      if (fisier.data.length > MAX)
        return inapoi("eroare", `Poza are ${Math.round(fisier.data.length / 1048576)} MB, prea mult. Fă-o din nou — pe telefon se micșorează singură.`);
      if (!/^image\//.test(fisier.contentType || ""))
        return inapoi("eroare", "Fișierul atașat nu e o poză.");
      poza = `data:${fisier.contentType};base64,${fisier.data.toString("base64")}`;
    }

    const v = F.validareRetur({
      stare: String(b.stare || ""),
      produs_id: nr(b.produs_id),
      cantitate: nr(b.cantitate),
      motiv: b.motiv,
      poza,
    });
    if (!v.ok) return inapoi("eroare", v.motiv);

    let miscareId = null;
    if (v.miscare) {
      const ins = await db
        .prepare(
          `INSERT INTO ff_miscari (produs_id, cantitate, fel, referinta, awb, data, creat_de, observatii)
           VALUES (?, ?, 'retur', ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(
          v.miscare.produs_id,
          v.miscare.cantitate,
          `retur ${r.awb || ""}`.trim(),
          r.awb,
          azi(),
          ctx.user ? ctx.user.id : null,
          String(b.motiv || "").slice(0, 200) || null
        );
      miscareId = ins.lastInsertRowid || null;
    }

    await db
      .prepare(
        `UPDATE ff_retururi SET produs_id = ?, cantitate = ?, stare = ?, motiv = ?, poza = ?,
                decis_la = ?, decis_de = ?, miscare_id = ? WHERE id = ?`
      )
      .run(
        nr(b.produs_id),
        nr(b.cantitate),
        v.stare,
        String(b.motiv || "").slice(0, 300) || null,
        poza || null,
        acum(),
        ctx.user ? ctx.user.id : null,
        miscareId,
        r.id
      );

    return inapoi(
      "ok",
      v.stare === "in_stoc"
        ? `${cant(b.cantitate)} s-au întors în stocul de fulfillment.`
        : `${cant(b.cantitate)} au ieșit din gestiune ca marfă deteriorată, cu poză și motiv.`
    );
  });
}

module.exports = { register, stocCurent, comenziZi, CALE };
