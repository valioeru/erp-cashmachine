"use strict";
// Fulfillment — comenzile Sameday, ambalate din stocul ținut acolo.
//
// ALTĂ GESTIUNE DECÂT CT-PARK, ȘI FIZIC ALT LOC. Vali, când l-am întrebat:
// „E complet diferit de ct-park, iese din depozit în altă zonă inclusiv
// fizic.” De-aia marfa care pleacă din depozit spre fulfillment nu e o
// mutare de palet: paletul iese din CT-Park, iar aici intră o cantitate pe
// produs. Două gestiuni, două socoteli, un transfer între ele.
//
// CE REFOLOSEȘTE, ȘI DE CE. Comenzile nu se importă din nou aici. AWB-urile
// Sameday intră deja prin „Comenzi consumabile la zi” (modules/comenzi-zi.js),
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
const drive = require("../lib/drive");

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
    [`${CALE}/etichete`, "Etichete AWB"],
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
// explica. Când cineva întreabă „de unde au apărut 300 de topuri aici”,
// răspunsul trebuie să fie un rând cu data și documentul.
async function stocCurent() {
  const randuri = await db
    .prepare(
      `SELECT m.produs_id, SUM(m.cantitate) AS cantitate,
              p.denumire, p.cod, p.unitate_masura
         FROM ff_miscari m JOIN produse p ON p.id = m.produs_id
        WHERE COALESCE(m.test, 0) = 0
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
    // poate răspunde la „de câte zile stă asta” fără un istoric separat.
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
      // odată ambalată și scanată, comanda nu mai e „are marfă”, e gata.
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
        în capul listei pe măsură ce îmbătrânesc. Coloana „Zile” e vechimea față de azi.
      </p>
      ${randuri.length ? table(["AWB", "Client", "Din ziua", "Zile", "Stare", "Observații"], randuri) : "<p>Nu stă nimic în urmă.</p>"}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Fulfillment — în așteptare", active: CALE, body }));
  });

  // ---- Stocul din fulfillment -------------------------------------------
  router.get(`${CALE}/stoc`, async (ctx) => {
    const { randuri, harta } = await stocCurent();
    const ultimele = await db
      .prepare(
        `SELECT m.*, p.denumire FROM ff_miscari m JOIN produse p ON p.id = m.produs_id
          ORDER BY m.data DESC, m.id DESC LIMIT 40`
      )
      .all();

    const FELURI = {
      stoc_initial: "stoc inițial",
      intrare_depozit: "din depozit",
      consum_comanda: "pe o comandă",
      retur: "retur",
      corectie: "corecție",
    };
    const produse = await db
      .prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE COALESCE(activ,1) = 1 ORDER BY denumire LIMIT 800")
      .all();
    const areInitial = await db.prepare("SELECT 1 AS x FROM ff_miscari WHERE fel = 'stoc_initial' LIMIT 1").get();

    const body = `
      ${subtabs(`${CALE}/stoc`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Stoc în fulfillment</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
        Gestiune separată de CT-Park, și fizic alt loc. Cifrele de aici nu se scriu nicăieri ca atare:
        se adună din mișcări, ca la orice întrebare de felul „de unde au apărut astea” să existe un rând cu
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

      <h2 style="margin-top:22px">Stoc inițial</h2>
      <p style="font-size:13px;color:var(--text-muted);max-width:900px;margin:0 0 10px">
        Ce era deja în fulfillment când a pornit evidența. Se scrie o dată, din numărătoare, și de la el încolo
        totul se mișcă singur: intrări din depozit, consum pe comenzi, retururi.
        ${
          areInitial
            ? `<strong>S-a mai scris un stoc inițial.</strong> Poți adăuga și pe alte produse, dar dacă rescrii
               unul deja numărat, cantitățile se adună — nu se înlocuiesc. Pentru o corecție, scrie diferența,
               cu minus dacă e mai puțin.`
            : "Încă nu s-a scris niciunul."
        }
      </p>
      ${
        produse.length
          ? `<form class="form" method="post" action="${CALE}/stoc-initial" style="max-width:860px">
               ${/* Lista intreaga de produse, cu o casuta langa fiecare.
                    A fost intai un formular cu cinci liste derulante, si Vali
                    a taiat-o scurt: „Trebuie sa fie ceva simplu, lista de
                    produse si stoc initial si aia e.” Avea dreptate — la o
                    numaratoare te plimbi prin depozit cu lista in fata si
                    scrii cifra unde o gasesti, nu alegi produsul din meniu
                    de cinci ori si o iei de la capat. */ ""}
               <input type="search" id="cauta-produs" placeholder="caută în listă…" autocomplete="off"
                      style="width:100%;max-width:360px;padding:6px 8px;margin-bottom:8px">
               <table class="table" style="margin-bottom:10px">
                 <thead><tr><th>Produs</th><th>Cod</th><th style="width:120px">Stoc acum</th><th style="width:140px">Stoc inițial</th></tr></thead>
                 <tbody id="lista-initial">
                   ${produse
                     .map((p) => {
                       const are = harta.get(Number(p.id)) || 0;
                       return `<tr data-cauta="${esc(((p.denumire || "") + " " + (p.cod || "")).toLowerCase())}">
                         <td>${esc(p.denumire)}</td>
                         <td style="color:var(--text-muted);font-size:12px">${esc(p.cod || "—")}</td>
                         <td style="color:var(--text-muted)">${are ? cant(are) + " " + esc(p.unitate_masura || "") : "—"}</td>
                         <td><input type="number" name="q_${p.id}" step="0.001" placeholder="0"
                                    style="width:110px;padding:4px 6px"></td>
                       </tr>`;
                     })
                     .join("")}
                 </tbody>
               </table>
               <label class="field" style="max-width:220px">Când s-a numărat<input type="date" name="data" value="${esc(azi())}"></label>
               <div class="form-actions"><button class="btn" type="submit">Scrie stocul inițial</button></div>
             </form>
             <script>
               (function () {
                 var c = document.getElementById("cauta-produs");
                 if (!c) return;
                 c.addEventListener("input", function () {
                   var t = c.value.trim().toLowerCase();
                   var randuri = document.querySelectorAll("#lista-initial tr");
                   for (var i = 0; i < randuri.length; i++) {
                     var r = randuri[i];
                     // Un rand cu cifra scrisa NU se ascunde niciodata, oricat
                     // ai filtra: altfel cauti altceva, dispare din ochi, si
                     // crezi ca n-ai scris-o. Cifra pleaca oricum la salvare,
                     // fiindca ascunsul tot in formular e — dar omul trebuie
                     // sa vada ce a completat.
                     var inp = r.querySelector("input");
                     var scrisa = inp && inp.value !== "";
                     r.hidden = !scrisa && t && r.dataset.cauta.indexOf(t) === -1;
                   }
                 });
               })();
             </script>`
          : "<p>Nu e niciun produs activ în nomenclator.</p>"
      }

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

  // ---- Stocul inițial ----------------------------------------------------
  //
  // Prima numărare: ce era deja acolo când a pornit evidența. Nu e o
  // corecție, e punctul de la care începe socoteala — de-aia are felul lui
  // în mișcări. Peste un an trebuie să se poată spune ce a fost inventar de
  // pornire și ce a fost pierdere, iar asta e exact ce se întreabă la
  // primul control de gestiune.
  router.post(`${CALE}/stoc-initial`, async (ctx) => {
    const b = ctx.body || {};
    const inapoi = (fel, text) => redirect(ctx.res, `${CALE}/stoc?${fel}=${encodeURIComponent(text)}`);
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(b.data || "")) ? String(b.data) : azi();

    // Formularul trimite o căsuță pentru FIECARE produs din listă, numită
    // „q_<id>”. Se iau doar cele completate: restul vin goale și nu înseamnă
    // „zero bucăți”, ci „n-am numărat produsul ăsta”. Diferența contează —
    // un zero scris ar fi o afirmație, iar un gol e tăcere.
    const peProdus = new Map();
    for (const cheie of Object.keys(b)) {
      if (!/^q_\d+$/.test(cheie)) continue;
      const brut = String(b[cheie]).trim();
      if (brut === "") continue;
      const cantitate = nr(brut);
      if (!isFinite(cantitate)) continue;
      peProdus.set(Number(cheie.slice(2)), cantitate);
    }
    if (!peProdus.size) return inapoi("eroare", "N-ai scris nicio cantitate.");

    for (const [produsId, cantitate] of peProdus) {
      await db
        .prepare(
          `INSERT INTO ff_miscari (produs_id, cantitate, fel, referinta, data, creat_de, observatii)
           VALUES (?, ?, 'stoc_initial', 'numărătoare de pornire', ?, ?, ?)`
        )
        .run(produsId, cantitate, data, ctx.user ? ctx.user.id : null, String(b.observatii || "").slice(0, 200) || null);
    }
    return inapoi(
      "ok",
      `Stoc inițial scris pe ${peProdus.size} ${peProdus.size === 1 ? "produs" : "produse"}, numărat la ${dataRo(data)}.`
    );
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
    // O PARTE din palet: ieșirea se face ca oricare altă ieșire parțială din
    // CT-Park (modules/ct-park.js, iesirePartiala) — scade LINIA paletului,
    // rescrie rezumatul și lasă ieșirea scrisă în `ct_iesiri`.
    //
    // CE ERA GREȘIT (găsit pe 10.11.2026, citind codul): aici se scădea doar
    // cantitatea din antetul paletului. Linia lui rămânea întreagă, iar Stoc
    // la zi citește liniile — deci marfa adusă în fulfillment ar fi rămas
    // numărată și în CT-Park —, și nu rămânea nicio ieșire scrisă. Se face
    // ÎNAINTE de a scrie intrarea în fulfillment: dacă ieșirea e refuzată,
    // nu intră nimic nicăieri.
    if (!tot) {
      const linii = await db
        .prepare("SELECT id, cantitate FROM ct_palet_linii WHERE palet_id = ? AND cantitate > 0 ORDER BY id")
        .all(palet.id)
        .catch(() => []);
      if (linii.length !== 1) {
        return inapoi("eroare", "Din paletul ăsta nu pot aduce doar o parte: adu-l întreg, sau scoate partea din fișa paletului, cu destinația Fulfillment.");
      }
      // Antetul paletului spune mai mult decât marfa de pe el (date stricate):
      // nu se scoate ce nu există, și omul află unde să se uite.
      const peLinie = nr(linii[0].cantitate);
      if (cat > peLinie + 1e-9) {
        return inapoi("eroare", `Pe palet sunt de fapt ${cant(peLinie)} ${palet.um || ""}, nu ${cant(cat)}: cantitatea scrisă pe palet nu se potrivește cu marfa de pe el. Verifică fișa paletului.`.replace(/\s+/g, " "));
      }
      const iesire = await require("./ct-park").iesirePartiala(ctx.user, palet.id, {
        destinatie: "fulfillment",
        observatii: `transfer în gestiunea de fulfillment${String(b.observatii || "").trim() ? " — " + String(b.observatii).trim().slice(0, 200) : ""}`,
        ["pleaca_" + linii[0].id]: String(cat),
        ["ramane_" + linii[0].id]: String(Math.round((peLinie - cat) * 1e6) / 1e6),
      });
      if (iesire.eroare) return inapoi("eroare", iesire.eroare);
    }
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
    }
    // Parțial: paletul rămâne pe locul lui, cu restul — ieșirea lui s-a făcut
    // mai sus, înainte de intrarea în fulfillment.

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
  // face cu acea marfă.”
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
    const cateProba = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ff_retururi WHERE COALESCE(test,0) = 1)
              + (SELECT COUNT(*) FROM ff_miscari WHERE COALESCE(test,0) = 1) AS n`
      )
      .get();
    const deProba = nr(cateProba && cateProba.n);

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

      ${
        deProba
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#b8860b);max-width:980px;margin-bottom:12px">
               <strong>Ai ${deProba} ${deProba === 1 ? "rând de probă" : "rânduri de probă"} în fulfillment.</strong>
               Nu ating stocul și nu intră în nicio socoteală — dar stau în listă până le ștergi.
               <form method="post" action="${CALE}/proba/sterge" style="display:inline;margin-left:8px">
                 <button class="btn small secondary" type="submit">Șterge tot ce am făcut în probă</button>
               </form>
             </div>`
          : ""
      }

      <form class="form" method="post" action="${CALE}/retururi/scan" style="max-width:620px;margin-bottom:18px">
        <label class="field">Scanează AWB-ul returului
          <input name="awb" id="awb-retur" autofocus autocomplete="off" placeholder="scanează sau scrie AWB-ul"
                 style="font-size:18px;font-family:ui-monospace,monospace" required>
        </label>
        ${/* Modul de probă: scanezi cu AWB-uri adevărate, pe datele
             adevărate, dar nimic nu ajunge în stoc. „Sa am posibilitatea sa
             scanez awb si sa fac doar test si roll back apoi.”
             Un test pe altă bază n-ar fi spus nimic — abia pe datele reale
             se vede dacă AWB-ul tău chiar se recunoaște. */ ""}
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;margin:-4px 0 10px">
          <input type="checkbox" name="test" value="1"${deProba ? " checked" : ""}>
          <span><strong>Doar probă</strong> — scanez ca să văd ce iese, fără să ating stocul. Se poate șterge tot, dintr-un buton.</span>
        </label>
        <div class="form-actions"><button class="btn" type="submit">A sosit</button></div>
      </form>
      ${/* Cititorul „tastează” codul și dă Enter. Formularul are un singur
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
                    ${nr(r.test) ? '<span class="badge galben" style="font-size:10px">probă</span>' : ""}
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
                `<code>${esc(r.awb || "—")}</code>${nr(r.test) ? ' <span class="badge galben" style="font-size:10px">probă</span>' : ""}`,
                esc(r.denumire || "—"),
                cant(r.cantitate),
                r.stare === "in_stoc"
                  ? '<span class="badge verde">înapoi în stoc</span>'
                  : '<span class="badge rosu">deteriorată, scoasă</span>',
                esc(r.motiv || "—"),
                // O poză din Drive e un link, nu o imagine pe care o putem
                // pune în pagină: Drive nu servește fișierul direct. Cele
                // rămase în bază (când Drive n-a răspuns) sunt data-URL și
                // se pot arăta ca miniatură.
                r.poza
                  ? /^data:/.test(r.poza)
                    ? `<a href="${esc(r.poza)}" target="_blank"><img src="${esc(r.poza)}" alt="poza returului" style="height:38px;border-radius:3px;border:1px solid var(--border)"></a> <span style="font-size:10px;color:var(--warn)">în bază</span>`
                    : `<a href="${esc(r.poza)}" target="_blank">vezi în Drive</a>`
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

    const test = String((ctx.body || {}).test || "") === "1" ? 1 : 0;
    await db
      .prepare(
        `INSERT INTO ff_retururi (awb, produs_id, cantitate, stare, scanat_la, scanat_de, test)
         VALUES (?, ?, ?, 'de_decis', ?, ?, ?)`
      )
      .run(awb, linie ? linie.produs_id : null, linie ? nr(linie.cantitate) : null, acum(), ctx.user ? ctx.user.id : null, test);

    const prefix = test ? "PROBĂ: " : "";
    return inapoi(
      "ok",
      linie
        ? `${prefix}Returul ${awb} a fost înregistrat, cu ce scria pe comanda lui. Verifică și alege ce faci cu marfa.`
        : `${prefix}Returul ${awb} a fost înregistrat. Nu cunosc AWB-ul ăsta, deci spune tu ce s-a întors.`
    );
  });

  router.post(`${CALE}/retururi/:id/decide`, async (ctx) => {
    const b = ctx.body || {};
    const inapoi = (fel, text) => redirect(ctx.res, `${CALE}/retururi?${fel}=${encodeURIComponent(text)}`);
    const r = await db.prepare("SELECT * FROM ff_retururi WHERE id = ?").get(ctx.params.id);
    if (!r) return inapoi("eroare", "Returul nu există.");
    if (r.stare !== "de_decis") return inapoi("eroare", "Returul ăsta a fost deja rezolvat.");

    // POZA MERGE ÎN DRIVE, NU ÎN BAZĂ.
    //
    // Prima variantă o ținea ca data-URL într-o coloană. Vali: „Salveaz-o în
    // drive nu în browser, ca să nu se încarce baza pe Render.” Are dreptate:
    // câteva sute de retururi pe an înseamnă sute de megaocteți de poze
    // într-o bază care trebuie să fie rapidă la cu totul altceva, iar un
    // backup de bază se face și se restaurează mult mai des decât se deschid
    // pozele. În Drive stau ieftin, se văd dintr-un link, și nu încetinesc
    // nimic.
    //
    // Micșorarea din browser rămâne: 3-5 MB devin 200-400 KB, deci urcarea e
    // instantanee chiar și de pe terminal, pe WiFi-ul din depozit.
    const MAX = 8 * 1024 * 1024;
    let octeti = null;
    let mime = "image/jpeg";
    const dataUrl = String(b.poza_cale || "").trim();
    const fisier = (b.__files && b.__files.poza && b.__files.poza[0]) || null;
    if (dataUrl) {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
      if (!m) return inapoi("eroare", "Poza n-a ajuns întreagă. Încearcă din nou.");
      mime = m[1];
      octeti = Buffer.from(m[2], "base64");
    } else if (fisier && fisier.data && fisier.data.length) {
      if (!/^image\//.test(fisier.contentType || "")) return inapoi("eroare", "Fișierul atașat nu e o poză.");
      if (fisier.data.length > MAX)
        return inapoi("eroare", `Poza are ${Math.round(fisier.data.length / 1048576)} MB, prea mult. Fă-o din nou — pe telefon se micșorează singură.`);
      mime = fisier.contentType;
      octeti = fisier.data;
    }

    // `poza` ajunge în baza de date ca LINK, nu ca imagine.
    let poza = "";
    let notaPoza = "";
    if (octeti && octeti.length) {
      try {
        const radacina = process.env.GOOGLE_DRIVE_FOLDER;
        if (!radacina) throw new Error("GOOGLE_DRIVE_FOLDER nu e setată în Render");
        const luna = azi().slice(0, 7);
        const folder = await drive.cale(["Retururi fulfillment", luna], radacina);
        const ext = /png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : "jpg";
        const rez = await drive.urca({
          nume: `retur-${String(r.awb || r.id).replace(/[^A-Za-z0-9_-]/g, "")}-${Date.now()}.${ext}`,
          mime,
          continut: octeti,
          parinte: folder,
        });
        poza = rez.link;
      } catch (e) {
        // Drive n-a răspuns. NU pierdem dovada: marfa e pe masă acum, iar
        // peste o oră e la gunoi și poza nu se mai poate face. Rămâne în
        // bază, dar se spune pe față — altfel ar părea că a plecat în Drive.
        poza = `data:${mime};base64,${octeti.toString("base64")}`;
        notaPoza = ` Atenție: Drive n-a răspuns (${String(e.message || e).slice(0, 80)}), deci poza a rămas în baza ERP.`;
      }
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
          `INSERT INTO ff_miscari (produs_id, cantitate, fel, referinta, awb, data, creat_de, observatii, test)
           VALUES (?, ?, 'retur', ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(
          v.miscare.produs_id,
          v.miscare.cantitate,
          `retur ${r.awb || ""}`.trim(),
          r.awb,
          azi(),
          ctx.user ? ctx.user.id : null,
          String(b.motiv || "").slice(0, 200) || null,
          // Decizia mosteneste semnul de la scanare: daca AWB-ul a fost
          // scanat in proba, si miscarea care iese din el e proba. Altfel
          // un test ar lasa in urma o intrare adevarata in stoc.
          nr(r.test) ? 1 : 0
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
      (v.stare === "in_stoc"
        ? `${cant(b.cantitate)} s-au întors în stocul de fulfillment.`
        : `${cant(b.cantitate)} au ieșit din gestiune ca marfă deteriorată, cu poză și motiv.`) + notaPoza
    );
  });

  // ---- Anularea probei ---------------------------------------------------
  //
  // „Sa fac doar test si roll back apoi.” Un buton, nu o curățenie făcută cu
  // mâna prin tabele: altfel rămân urme, iar peste o lună nimeni nu mai știe
  // care rând a fost probă.
  //
  // Se șterg DOAR rândurile marcate ca probă. Nici nu putea fi altfel —
  // stocul nici nu le-a numărat vreodată, toate socotelile cer test = 0.
  // Deci chiar dacă cineva uită să apese butonul ăsta, cifrele firmei rămân
  // curate; proba doar stă în listă și deranjează la citit.
  router.post(`${CALE}/proba/sterge`, async (ctx) => {
    const m = await db.prepare("DELETE FROM ff_miscari WHERE COALESCE(test,0) = 1 RETURNING id").all();
    const r = await db.prepare("DELETE FROM ff_retururi WHERE COALESCE(test,0) = 1 RETURNING id").all();
    let s = [];
    try {
      s = await db.prepare("DELETE FROM ff_stare WHERE COALESCE(test,0) = 1 RETURNING id").all();
    } catch (e) {
      /* tabelul poate fi gol sau fara coloana pe o baza mai veche */
    }
    const total = (m || []).length + (r || []).length + (s || []).length;
    return redirect(
      ctx.res,
      `${CALE}/retururi?ok=${encodeURIComponent(
        total ? `S-au șters ${total} rânduri de probă. Stocul n-a fost atins niciodată de ele.` : "Nu era nimic de probă."
      )}`
    );
  });

  // ---- Etichetele AWB, pentru Zebra -------------------------------------
  //
  // CE NU POATE FACE ERP-UL, ȘI DE CE PAGINA ARATĂ AȘA. ERP-ul rulează pe
  // Render, în alt oraș decât imprimanta. Un server din cloud nu poate
  // trimite nimic într-o imprimantă din depozit — între ele e tot internetul
  // și un router care nu lasă pe nimeni înăuntru. Deci „automat” nu poate
  // însemna „serverul printează”; înseamnă „pagina asta, lăsată deschisă pe
  // calculatorul de lângă Zebra, se uită singură dacă a apărut ceva nou și
  // îl scoate la imprimantă”. Asta chiar merge, și merge fără dialog dacă
  // Chrome-ul de pe acel calculator e pornit cu --kiosk-printing și Zebra e
  // imprimanta implicită.
  //
  // Butonul rămâne, pentru cele două situații în care automatul nu ajută:
  // fila a fost închisă peste noapte, sau s-a stricat un teanc și trebuie
  // scos din nou.

  router.get(`${CALE}/etichete`, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const fisiere = await etichetePdf(14);
    const neprintate = fisiere.filter((f) => !f.printat_la).length;
    const casute = await casuteAwb();
    const blocate = casute.filter((c) => c.ultima_eroare);
    const ultima = casute.map((c) => String(c.ultima_sincronizare || "")).sort().pop() || "";
    const stareEmail = `
      <div class="card" style="margin-bottom:14px;max-width:920px${blocate.length ? ";border-left:4px solid var(--danger)" : ""}">
        <form method="post" action="${CALE}/etichete/adu" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0">
          <button class="btn" type="submit" id="adu-awb">Adu AWB-urile acum</button>
          <span style="font-size:13px;color:var(--text-muted)">
            ${
              casute.length
                ? `Emailul se citește singur la 5 minute${ultima ? `; ultima dată la <strong>${esc(oraRo(ultima))}</strong>` : ""}
                   (${casute.map((c) => esc(c.adresa)).join(", ")}). Dacă lipsesc teancurile de azi-noapte, apasă butonul.`
                : `Nu e nicio căsuță de email pornită din care să vină etichete — vezi <a href="/email/conturi">Email → Căsuțe</a>.`
            }
          </span>
        </form>
        ${blocate
          .map(
            (c) => `<p style="margin:8px 0 0;font-size:13px;color:var(--danger)" role="alert">
              <strong>${esc(c.adresa)} nu se citește:</strong> ${esc(String(c.ultima_eroare).slice(0, 260))}
              Cât scrie asta, etichetele noi din căsuța ei nu ajung aici.</p>`
          )
          .join("")}
      </div>`;

    const randuri = fisiere.map((f) => [
      `<input type="checkbox" class="bif-teanc" data-id="${f.id}" data-printat="${f.printat_la ? 1 : 0}"
              data-zi="${esc(`${dataRo(f.zi)} ${String(f.ora || "")}`.trim())}"
              aria-label="Alege teancul din ${dataRo(f.zi)}">`,
      `<strong>${dataRo(f.zi)}</strong> <span style="color:var(--text-muted)">${esc(String(f.ora || ""))}</span>`,
      `<a href="${CALE}/etichete/${f.id}/pdf" target="_blank">${esc(f.nume)}</a>`,
      f.marime ? Math.round(nr(f.marime) / 1024).toLocaleString("ro-RO") + " KB" : "—",
      `<span class="stare-teanc">${
        f.printat_la
          ? `<span class="badge verde">printat ${esc(candRo(f.printat_la))}</span>${
              f.automat ? " <span style=\"color:var(--text-muted);font-size:12px\">automat</span>" : ""
            }${nr(f.exemplare) > 1 ? ` <span style="color:var(--text-muted);font-size:12px">×${nr(f.exemplare)}</span>` : ""}`
          : '<span class="badge">neprintat</span>'
      }</span>`,
      `<button class="btn secondary" type="button" data-print="${f.id}">${f.printat_la ? "Printează din nou" : "Printează"}</button>`,
    ]);

    const body = `
      ${subtabs(`${CALE}/etichete`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Etichete AWB<span id="cate-neprintate" style="color:var(--warn)">${
        neprintate ? ` — ${neprintate} ${neprintate === 1 ? "teanc neprintat" : "teancuri neprintate"}` : ""
      }</span></h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:920px">
        Teancurile de etichete vin de la Sameday imediat după miezul nopții, câteva emailuri pe noapte, fiecare
        cu un <code>awbs.pdf</code>. Ele ajung singure în Drive; aici se vede doar ce-a ieșit la imprimantă și
        ce nu. Un teanc se printează întreg — nu se taie pe AWB-uri, ca să nu existe un al doilea loc în care
        se pot pierde etichete.
      </p>
      <p style="margin:0 0 12px;font-size:13px;max-width:920px">
        <strong>Cum printezi:</strong> apeși „Printează” pe rândul teancului (sau bifezi mai multe și „Printează
        acum…”). Teancul se deschide pe ecran împreună cu fereastra de tipărire, care rămâne deschisă: alegi
        imprimanta de etichete, apeși Print și, după ce au ieșit, „Am printat”.
      </p>
      ${stareEmail}
      <div class="card" style="margin-bottom:14px;max-width:920px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:600">
          <input type="checkbox" id="auto"> Printează singur ce apare
        </label>
        <p style="margin:6px 0 0;font-size:13px;color:var(--text-muted)">
          Lasă fila asta deschisă pe calculatorul de lângă Zebra. Verifică din cinci în cinci minute și scoate
          teancurile noi. <strong>Merge numai dacă</strong> Chrome-ul de pe acel calculator e pornit cu
          <code>--kiosk-printing</code> și Zebra e imprimanta implicită: altfel Chrome cere de fiecare dată să
          apeși Print, iar automatul n-are cine să apese — teancurile ar fi trecute ca printate fără să iasă.
          Fără <code>--kiosk-printing</code> nu bifa aici; printează cu butoanele. Bifa se ține pe calculatorul
          ăsta, nu pe cont.
        </p>
        <p style="margin:6px 0 0;font-size:13px" id="stare-auto"></p>
        <p style="margin:6px 0 0;font-size:13px;color:var(--text-muted)">
          Automatul se uită numai la ultimele 36 de ore. Teancurile mai vechi se scot cu butonul din dreapta
          lor — sau, dacă au fost deja printate de mână, se trec ca făcute fără hârtie.
        </p>
      </div>
      ${
        neprintate && ctx.user.rol === "admin"
          ? `<form method="post" action="${CALE}/etichete/marcheaza-tot" id="marcheaza-tot" style="margin:-6px 0 14px">
               <button class="btn secondary" type="submit">Marchează toate cele <span id="cate-de-marcat">${neprintate}</span> ca făcute, fără să printezi</button>
             </form>`
          : ""
      }
      ${
        randuri.length
          ? `<div class="bara-teancuri" id="bara-teancuri">
               <span class="bif-grup">
                 <button class="btn secondary small" type="button" data-alege="tot">Selectează tot</button>
                 <button class="btn secondary small" type="button" data-alege="neprintate">Doar neprintate</button>
                 <button class="btn secondary small" type="button" data-alege="nimic">Niciuna</button>
               </span>
               <span id="cate-alese" class="cate-alese">niciun teanc ales</span>
               <button class="btn" type="button" id="printeaza-alese" disabled>Printează acum ce e selectat</button>
               <span id="rezultat-tipar" role="status" style="font-size:13px;width:100%"></span>
             </div>
             ${table(
               [
                 '<input type="checkbox" id="bif-tot" aria-label="Selectează toate teancurile">',
                 "Ziua emailului",
                 "Fișier",
                 "Mărime",
                 "Stare",
                 "",
               ],
               randuri
             )}`
          : "<p>N-a venit niciun teanc de etichete în ultimele două săptămâni.</p>"
      }
      <div id="tipar-vazut" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Teancul de etichete, de tipărit"
           data-pauza-automat="30000" data-reincarca-dupa="180000"
           style="visibility:hidden;pointer-events:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2000;background:rgba(0,0,0,.45);display:flex;padding:2vh 2vw;box-sizing:border-box">
        <div style="flex:1 1 auto;display:flex;flex-direction:column;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.35);overflow:hidden">
          <div style="padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border)">
            <strong id="tipar-vazut-titlu">Teancul de etichete</strong>
            <span style="font-size:13px;color:var(--text-muted);flex:1 1 300px">
              Fereastra de tipărire se deschide singură și <strong>rămâne deschisă</strong>: alege imprimanta de
              etichete și apasă Print. După ce au ieșit etichetele, apasă „Am printat”.
            </span>
            <button class="btn secondary" type="button" id="tipar-vazut-iar">Deschide iar fereastra de tipărire</button>
            <button class="btn" type="button" id="tipar-vazut-da">Am printat</button>
            <button class="btn secondary" type="button" id="tipar-vazut-nu">Nu l-am printat</button>
            <button class="btn secondary" type="button" id="tipar-vazut-stop" style="display:none">Oprește aici</button>
          </div>
          <div id="tipar-vazut-loc" style="flex:1 1 auto;display:flex;min-height:0"></div>
        </div>
      </div>
      <style>
        .bara-teancuri { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:0 0 10px; }
        .bif-grup { display:flex; gap:6px; flex-wrap:wrap; }
        .cate-alese { font-size:13px; color:var(--text-muted); margin-right:auto; }
        /* Bifele sunt ținta principală a paginii: la 18px se nimeresc și cu
           degetul, pe telefonul de lângă imprimantă. */
        .bif-teanc, #bif-tot { width:18px; height:18px; cursor:pointer; }
        @media (max-width: 760px) {
          .cate-alese { margin-right:0; width:100%; }
          .bara-teancuri > .btn { width:100%; }
        }
      </style>
      <script>
      (function () {
        var CALE = ${JSON.stringify(CALE)};
        var sus = document.getElementById("stare-auto");
        var bifa = document.getElementById("auto");
        var ocupat = false;
        var oprit = false;
        var ultimaTiparire = 0;
        function spune(t) { sus.textContent = t; }
        try { bifa.checked = localStorage.getItem("ff-print-auto") === "1"; } catch (e) {}
        bifa.addEventListener("change", function () {
          try { localStorage.setItem("ff-print-auto", bifa.checked ? "1" : "0"); } catch (e) {}
          spune(bifa.checked ? "Pornit. Verific acum…" : "Oprit.");
          if (bifa.checked) verifica();
        });

        // CUM SE TIPĂREȘTE UN TEANC, ȘI DE CE NIMIC NU SE MAI ÎNCHIDE SINGUR.
        //
        // Vali, 11.11.2026: „merge foarte rău, a doua, a treia oară printează,
        // și doar dacă în fereastra de print apăs eu butonul. Ori lași
        // fereastra deschisă și apăsăm print, ori fă-l să meargă."
        //
        // Greșeala era a paginii, nu a imprimantei. La un PDF, print() NU
        // așteaptă: cere browserului fereastra de tipărire și se întoarce pe
        // loc (măsurat în Chrome 141: 0 ms). Pagina credea că s-a tipărit,
        // trecea teancul ca printat și se reîncărca după 1,2 secunde — iar
        // reîncărcarea închide fereastra de tipărire. Ieșea ceva doar dacă
        // omul apuca să apese Print în secunda aceea.
        //
        // Acum:
        //  - teancul se deschide LA VEDERE, peste pagină, și fereastra de
        //    tipărire se cere o dată, după ce s-a încărcat PDF-ul;
        //  - pagina nu se mai reîncarcă și nu mai umblă la cadru: fereastra
        //    de tipărire stă deschisă cât vrea omul;
        //  - teancul e trecut ca printat doar când omul apasă „Am printat";
        //  - cadrul din care s-a tipărit rămâne în pagină, neatins, și după
        //    aceea: un teanc mare se mai trimite la imprimantă câteva secunde
        //    după ce s-a apăsat Print, iar un cadru golit i-ar putea tăia
        //    drumul. De-aia fiecare teanc are cadrul lui.
        var eEdge = navigator.userAgent.indexOf("Edg/") !== -1;
        var vazut = document.getElementById("tipar-vazut");
        var locVazut = document.getElementById("tipar-vazut-loc");
        var titluVazut = document.getElementById("tipar-vazut-titlu");
        var btnDa = document.getElementById("tipar-vazut-da");
        var btnNu = document.getElementById("tipar-vazut-nu");
        var btnIar = document.getElementById("tipar-vazut-iar");
        var btnStop = document.getElementById("tipar-vazut-stop");
        var rezultat = document.getElementById("rezultat-tipar");
        var PAUZA_AUTOMAT = Number(vazut.getAttribute("data-pauza-automat")) || 30000;
        var REINCARCA_DUPA = Number(vazut.getAttribute("data-reincarca-dupa")) || 180000;
        var ASCUNS = "position:fixed;width:0;height:0;border:0;left:-9999px";
        function cadruNou(stil) {
          var c = document.createElement("iframe");
          c.className = "cadru-teanc";
          c.title = "Teancul de etichete";
          c.style.cssText = stil;
          return c;
        }
        function cereTiparire(c) {
          ultimaTiparire = Date.now();
          try { c.contentWindow.focus(); c.contentWindow.print(); return true; } catch (e) { return false; }
        }
        // Un cadru pus în pagină se „încarcă" o dată gol, înainte de PDF.
        // Tipărirea cerută atunci ar scoate o foaie albă: încărcarea goală nu
        // se pune la socoteală. (Dacă adresa nu se poate citi, mergem înainte.)
        function eGol(c) {
          try { return String(c.contentWindow.location.href).indexOf("/etichete/") === -1; } catch (e) { return false; }
        }
        function arataFereastra(da) {
          vazut.style.visibility = da ? "visible" : "hidden";
          vazut.style.pointerEvents = da ? "auto" : "none";
          vazut.setAttribute("aria-hidden", da ? "false" : "true");
        }
        function printeazaLaVedere(id, titlu, maiSunt) {
          return new Promise(function (gata, rau) {
            var ceas = null;
            var c = cadruNou("flex:1 1 auto;width:100%;border:0");
            function incheie() {
              clearTimeout(ceas);
              c.onload = null;
              // Cadrul NU se golește și NU se scoate din pagină (vezi mai sus):
              // se dă doar la o parte, cu PDF-ul lui cu tot.
              c.style.cssText = ASCUNS;
              ultimaTiparire = Date.now();
              btnDa.onclick = btnNu.onclick = btnIar.onclick = btnStop.onclick = null;
            }
            btnDa.onclick = function () { incheie(); gata(); };
            btnNu.onclick = function () { incheie(); rau(new Error("nu a fost printat")); };
            btnStop.onclick = function () { oprit = true; incheie(); rau(new Error("nu a fost printat")); };
            btnIar.onclick = function () { cereTiparire(c); };
            c.onload = function () {
              if (eGol(c)) return;
              // PDF-ul apare în vizualizator după ce s-a încărcat cadrul: îi
              // lăsăm o clipă, altfel tipărirea prinde pagina goală.
              clearTimeout(ceas);
              ceas = setTimeout(function () { cereTiparire(c); }, 1200);
            };
            titluVazut.textContent = titlu || "Teancul de etichete";
            btnStop.style.display = maiSunt ? "" : "none";
            arataFereastra(true);
            // Adresa ÎNAINTE de a-l pune în pagină: așa cadrul pornește direct
            // cu PDF-ul.
            c.src = CALE + "/etichete/" + id + "/pdf";
            locVazut.appendChild(c);
          });
        }

        // „Printează singur": fără om în față, deci din cadru ascuns. Merge
        // doar cu Chrome pornit cu --kiosk-printing, care trimite la
        // imprimantă fără fereastră. Și aici print() se întoarce pe loc, deci
        // între două teancuri se așteaptă — altfel al doilea ar intra peste
        // primul — iar lista se reîncarcă abia după câteva minute de liniște.
        function printeazaAscuns(id) {
          return new Promise(function (gata, rau) {
            var c = cadruNou(ASCUNS);
            var ceas = setTimeout(function () { c.onload = null; rau(new Error("PDF-ul nu s-a încărcat")); }, 60000);
            c.onload = function () {
              if (eGol(c)) return;
              clearTimeout(ceas);
              c.onload = null;
              if (!cereTiparire(c)) return rau(new Error("tipărirea nu a pornit"));
              setTimeout(gata, PAUZA_AUTOMAT);
            };
            c.src = CALE + "/etichete/" + id + "/pdf#toolbar=0";
            document.body.appendChild(c);
          });
        }
        if (eEdge) {
          // Automatul trece teancurile ca printate fără să le vadă nimeni; în
          // Edge n-a fost încercat, deci nu-l lăsăm să pornească pe încredere.
          bifa.checked = false;
          bifa.disabled = true;
          spune("Tipărirea automată e făcută pentru Chrome pornit cu --kiosk-printing. În Edge n-a fost încercată, așa că aici rămâne oprită; cu butoanele se tipărește la fel ca în Chrome.");
        }

        // Scrisul în ERP se încearcă de trei ori: internetul din depozit mai
        // cade o clipă, iar un teanc ieșit și nenotat ar fi scos a doua oară.
        async function marcheaza(id, automat, eroare) {
          for (var i = 0; i < 3; i++) {
            try {
              var r = await fetch(CALE + "/etichete/" + id + "/printat", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ automat: automat ? 1 : 0, eroare: eroare || "" }),
              });
              var d = r.ok ? await r.json() : null;
              if (d && typeof d.ok === "boolean") return true;
            } catch (e) { /* mai încercăm o dată */ }
            if (i < 2) await new Promise(function (g) { setTimeout(g, 1500); });
          }
          return false;
        }
        function toateBifele() { return [].slice.call(document.querySelectorAll(".bif-teanc")); }
        function bifaLui(id) { return document.querySelector('.bif-teanc[data-id="' + id + '"]'); }
        function titluTeanc(id, i, n) {
          var bif = bifaLui(id);
          var zi = bif ? bif.getAttribute("data-zi") || "" : "";
          return (n > 1 ? "Teancul " + (i + 1) + " din " + n : "Teancul de etichete") + (zi ? " · din " + zi : "");
        }
        // Rândul se schimbă pe loc. Pagina NU se reîncarcă după un teanc
        // printat: reîncărcarea ar opri ce se mai trimite încă la imprimantă.
        function numaraNeprintate() {
          var n = toateBifele().filter(function (b) { return b.getAttribute("data-printat") !== "1"; }).length;
          var s = document.getElementById("cate-neprintate");
          if (s) s.textContent = n ? " — " + n + (n === 1 ? " teanc neprintat" : " teancuri neprintate") : "";
          var f = document.getElementById("marcheaza-tot");
          var c = document.getElementById("cate-de-marcat");
          if (c) c.textContent = String(n);
          if (f && !n) f.style.display = "none";
        }
        function treceCaPrintat(id, automat) {
          var bif = bifaLui(id);
          if (!bif) return;
          var rand = bif.closest("tr");
          bif.setAttribute("data-printat", "1");
          bif.checked = false;
          var stare = rand && rand.querySelector(".stare-teanc");
          if (stare) stare.innerHTML = '<span class="badge verde">printat acum</span>' + (automat ? ' <span style="color:var(--text-muted);font-size:12px">automat</span>' : "");
          var b = rand && rand.querySelector("[data-print]");
          if (b) { b.disabled = false; b.textContent = "Printează din nou"; }
          numaraNeprintate();
          numara();
        }
        // Întoarce: true = a ieșit și e notat; false = n-a ieșit;
        // "nenotat" = a ieșit, dar ERP-ul n-a putut scrie asta.
        async function unul(id, automat, titlu, maiSunt) {
          try {
            if (automat) await printeazaAscuns(id); else await printeazaLaVedere(id, titlu, maiSunt);
          } catch (e) {
            await marcheaza(id, automat, String(e && e.message || e));
            return false;
          }
          if (!(await marcheaza(id, automat, ""))) return "nenotat";
          treceCaPrintat(id, automat);
          return true;
        }
        var NENOTAT = "Etichetele au ieșit, dar ERP-ul n-a putut nota asta. Verifică internetul și reîncarcă pagina; nu scoate teancul a doua oară.";
        function zi(t) { if (rezultat) rezultat.textContent = t; }
        document.addEventListener("click", async function (ev) {
          var b = ev.target.closest("[data-print]");
          if (!b || ocupat) return;
          ocupat = true;
          zi("");
          b.disabled = true; b.textContent = "Se printează…";
          var id = b.getAttribute("data-print");
          var ok = await unul(id, false, titluTeanc(id, 0, 1), false);
          arataFereastra(false);
          ocupat = false;
          if (ok === "nenotat") { b.textContent = "Printat, dar nenotat"; zi(NENOTAT); }
          else if (!ok) { b.textContent = "N-a mers"; b.disabled = false; }
          numara();
        });

        // ---- mai multe teancuri deodată ------------------------------------
        //
        // Cererea lui Vali, 27.10.2026: dimineața sunt cinci-șase teancuri
        // venite peste noapte și le apăsa pe rând. Acum se bifează și pleacă
        // toate la imprimantă dintr-o apăsare.
        //
        // Se printează UNUL CÂTE UNUL, fiecare în fereastra lui la vedere:
        // următorul se deschide abia după ce omul a spus de cel dinainte că a
        // ieșit (sau că nu). „Oprește aici" lasă restul neatinse.
        var bifaTot = document.getElementById("bif-tot");
        var cateAlese = document.getElementById("cate-alese");
        var btnAlese = document.getElementById("printeaza-alese");
        function alese() { return toateBifele().filter(function (b) { return b.checked; }); }
        function numara() {
          if (!cateAlese) return;
          var n = alese().length;
          var t = toateBifele().length;
          cateAlese.textContent = n === 0 ? "niciun teanc ales" : n + " din " + t + (n === 1 ? " teanc ales" : " teancuri alese");
          btnAlese.disabled = n === 0 || ocupat;
          btnAlese.textContent = n ? "Printează acum " + (n === 1 ? "teancul ales" : "cele " + n + " teancuri") : "Printează acum ce e selectat";
          if (bifaTot) {
            bifaTot.checked = n > 0 && n === t;
            // Trei stări, nu două: bifa de sus arată „o parte” când e aleasă
            // doar o parte, altfel ar părea că n-ai ales nimic.
            bifaTot.indeterminate = n > 0 && n < t;
          }
        }
        if (bifaTot) {
          bifaTot.addEventListener("change", function () {
            toateBifele().forEach(function (b) { b.checked = bifaTot.checked; });
            numara();
          });
        }
        document.addEventListener("change", function (ev) {
          if (ev.target.classList && ev.target.classList.contains("bif-teanc")) numara();
        });
        var bara = document.getElementById("bara-teancuri");
        if (bara) {
          bara.addEventListener("click", function (ev) {
            var b = ev.target.closest("[data-alege]");
            if (!b) return;
            var ce = b.getAttribute("data-alege");
            toateBifele().forEach(function (x) {
              x.checked = ce === "tot" ? true : ce === "nimic" ? false : x.getAttribute("data-printat") !== "1";
            });
            numara();
          });
        }
        if (btnAlese) {
          btnAlese.addEventListener("click", async function () {
            var lista = alese().map(function (b) { return b.getAttribute("data-id"); });
            if (!lista.length || ocupat) return;
            // Cât timp scoatem teancurile alese, automatul stă deoparte.
            ocupat = true;
            oprit = false;
            zi("");
            btnAlese.disabled = true;
            var reusite = 0, nenotate = 0;
            for (var i = 0; i < lista.length && !oprit; i++) {
              var cum = await unul(lista[i], false, titluTeanc(lista[i], i, lista.length), i < lista.length - 1);
              if (cum === true) reusite++;
              else if (cum === "nenotat") nenotate++;
            }
            arataFereastra(false);
            ocupat = false;
            numara();
            zi(nenotate
              ? NENOTAT
              : reusite === lista.length
                ? "Gata, " + (reusite === 1 ? "teancul a ieșit." : "toate cele " + reusite + " teancuri au ieșit.")
                : "Au ieșit " + reusite + " din " + lista.length + ". Cele rămase sunt tot bifate.");
          });
        }
        numara();

        // Lista se reîncarcă doar după automat și doar în liniște: niciodată
        // cu un teanc deschis și niciodată la mai puțin de câteva minute de la
        // ultima tipărire cerută.
        function reincarcaInLiniste() {
          if (ocupat || Date.now() - ultimaTiparire < REINCARCA_DUPA) {
            return setTimeout(reincarcaInLiniste, Math.min(15000, REINCARCA_DUPA));
          }
          location.reload();
        }
        async function verifica() {
          if (eEdge || !bifa.checked || ocupat) return;
          ocupat = true;
          try {
            var r = await fetch(CALE + "/etichete/noi.json", { credentials: "same-origin", cache: "no-store" });
            var d = await r.json();
            if (!d.fisiere || !d.fisiere.length) {
              spune("Nimic nou. Ultima verificare " + new Date().toLocaleTimeString("ro-RO") + ".");
            } else {
              spune(d.fisiere.length + " teancuri noi, le trimit la imprimantă…");
              var n = 0;
              for (var i = 0; i < d.fisiere.length; i++) { if ((await unul(d.fisiere[i].id, true)) === true) n++; }
              spune("Am trimis la imprimantă " + n + " din " + d.fisiere.length + " la " + new Date().toLocaleTimeString("ro-RO") + ".");
              setTimeout(reincarcaInLiniste, REINCARCA_DUPA);
            }
          } catch (e) {
            spune("Nu pot verifica: " + (e && e.message || e));
          }
          ocupat = false;
        }
        setInterval(verifica, 5 * 60 * 1000);
        if (bifa.checked) setTimeout(verifica, 2000);
      })();
      </script>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Etichete AWB", active: CALE, body }));
  });

  // PDF-ul, servit de pe acelasi domeniu. Nu se trimite omul pe Drive: un
  // link de Drive se deschide in vizualizatorul lor, pe alt domeniu, de unde
  // pagina asta nu mai poate da print fara ca cineva sa apese.
  // „Adu AWB-urile acum" — Vali, 11.11.2026: „să le sincronizez iar dimineața,
  // dacă nu a rulat sincronizarea noaptea: în Fulfillment să am buton «adu
  // AWB-uri» și să se populeze manual atunci, ca să le pot imprima apoi".
  //
  // Citește pe loc căsuțele în care vin etichetele, fără să aștepte rândul de
  // la 5 minute (modules/inbox.js, sincronizeazaConturi). Așteaptă cel mult
  // ADU_ASTEPT_MS: o căsuță cu multe mesaje de recuperat poate dura minute,
  // iar cererea din browser nu ține atât. Ce nu s-a terminat merge mai departe
  // în fundal; pagina spune să fie reîncărcată.
  router.post(`${CALE}/etichete/adu`, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const inapoi = (cheie, text) => redirect(ctx.res, `${CALE}/etichete?${cheie}=${encodeURIComponent(text)}`);
    const casute = await casuteAwb();
    if (!casute.length) return inapoi("eroare", "Nu e nicio căsuță de email pornită din care să vină etichete. Vezi Email → Căsuțe.");
    const inainte = new Set((await etichetePdf(14)).map((f) => f.drive_id));
    const lucru = require("./inbox").sincronizeazaConturi(casute.map((c) => c.id));
    // Dacă rămâne în fundal, eroarea lui nu trebuie să doboare procesul.
    lucru.catch((e) => console.error("[fulfillment] aducerea AWB-urilor:", e && e.message));
    let ceas;
    const rez = await Promise.race([lucru, new Promise((r) => { ceas = setTimeout(() => r(null), ADU_ASTEPT_MS); })]).catch((e) => ({ cazut: String((e && e.message) || e) }));
    clearTimeout(ceas);
    if (rez && rez.cazut) return inapoi("eroare", `Emailul nu s-a putut citi: ${rez.cazut.slice(0, 300)}`);
    const noi = (await etichetePdf(14)).filter((f) => !inainte.has(f.drive_id));
    const spuneNoi = noi.length
      ? `${noi.length === 1 ? "A venit un teanc nou" : "Au venit " + noi.length + " teancuri noi"} de etichete.`
      : "";
    if (!rez) {
      return inapoi("ok", `${spuneNoi ? spuneNoi + " " : ""}Emailul se mai citește încă — sunt multe mesaje de recuperat. Reîncarcă pagina peste un minut.`.trim());
    }
    const erori = rez.filter((x) => x.eroare);
    if (erori.length) {
      return inapoi("eroare", `${spuneNoi ? spuneNoi + " " : ""}${erori[0].adresa} nu s-a citit: ${String(erori[0].eroare).slice(0, 300)}`.trim());
    }
    if (noi.length) return inapoi("ok", spuneNoi);
    if (rez.length && rez.every((x) => x.ocupat)) {
      return inapoi("ok", "Emailul se citea deja chiar acum. Reîncarcă pagina peste un minut.");
    }
    const ultim = (await etichetePdf(14))[0];
    return inapoi("ok", `Am citit emailul: nu a venit niciun teanc nou.${ultim ? ` Ultimul e din ${dataRo(ultim.zi)}, ${oraRo(ultim.data)}.` : ""}`);
  });

  router.get(`${CALE}/etichete/:id/pdf`, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const a = await db
      .prepare("SELECT id, nume, drive_id FROM email_atasamente WHERE id = ?")
      .get(Number(ctx.params.id));
    if (!a || !a.drive_id) return send(ctx.res, 404, "Nu găsesc fișierul.");
    let f;
    try {
      f = await drive.descarca(a.drive_id);
    } catch (e) {
      return send(ctx.res, 502, "Drive nu dă fișierul: " + String(e.message || e));
    }
    ctx.res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": f.continut.length,
      "Content-Disposition": `inline; filename="${String(a.nume || "awbs.pdf").replace(/[^\w.\-]/g, "_")}"`,
      "Cache-Control": "private, max-age=600",
    });
    ctx.res.end(f.continut);
  });

  router.post(`${CALE}/etichete/:id/printat`, async (ctx) => {
    if (!ctx.user) return send(ctx.res, 403, "{}");
    const id = Number(ctx.params.id);
    const b = ctx.body || {};
    const eroare = String(b.eroare || "").slice(0, 300) || null;
    const automat = Number(b.automat) ? 1 : 0;
    // O eroare NU marcheaza teancul ca printat: se scrie doar motivul, ca
    // urmatoarea verificare sa-l mai incerce o data.
    await db
      .prepare(
        `INSERT INTO ff_printari (atasament_id, printat_la, printat_de, automat, exemplare, eroare)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (atasament_id) DO UPDATE SET
           printat_la = COALESCE(EXCLUDED.printat_la, ff_printari.printat_la),
           printat_de = COALESCE(EXCLUDED.printat_de, ff_printari.printat_de),
           automat = EXCLUDED.automat,
           exemplare = ff_printari.exemplare + EXCLUDED.exemplare,
           eroare = EXCLUDED.eroare`
      )
      .run(id, eroare ? null : acum(), eroare ? null : ctx.user.id, automat, eroare ? 0 : 1, eroare);
    ctx.res.writeHead(200, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ ok: !eroare }));
  });

  // Automatul se uita numai la ULTIMELE 36 DE ORE, nu la toata lista.
  // Altfel, prima data cand cineva bifeaza „printeaza singur”, imprimanta ar
  // scoate doua saptamani de etichete vechi — adica exact genul de surpriza
  // dupa care nimeni nu mai bifeaza nimic. Restul se scot cu butonul, sau se
  // marcheaza ca facute fara sa se printeze.
  router.get(`${CALE}/etichete/noi.json`, async (ctx) => {
    if (!ctx.user) return send(ctx.res, 403, "{}");
    const limita = new Date(Date.now() - 36 * 3600000).toISOString().slice(0, 16).replace("T", " ");
    const fisiere = (await etichetePdf(3)).filter((f) => !f.printat_la && String(f.data || "") >= limita);
    ctx.res.writeHead(200, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ fisiere: fisiere.map((f) => ({ id: f.id, nume: f.nume, zi: f.zi })) }));
  });

  // Curatarea restantelor, fara hartie. Util o singura data, la pornire:
  // teancurile vechi au fost oricum printate de mana, pe vremea cand ERP-ul
  // nu tinea minte.
  router.post(`${CALE}/etichete/marcheaza-tot`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `${CALE}/etichete`);
    const fisiere = (await etichetePdf(60)).filter((f) => !f.printat_la);
    for (const f of fisiere) {
      await db
        .prepare(
          `INSERT INTO ff_printari (atasament_id, printat_la, printat_de, automat, exemplare, eroare)
           VALUES (?, ?, ?, 0, 0, 'marcat fara printare')
           ON CONFLICT (atasament_id) DO NOTHING`
        )
        .run(f.id, acum(), ctx.user.id);
    }
    return redirect(
      ctx.res,
      `${CALE}/etichete?ok=${encodeURIComponent(
        fisiere.length
          ? `${fisiere.length} teancuri marcate ca făcute, fără să se printeze nimic.`
          : "Nu era niciun teanc neprintat."
      )}`
    );
  });
}

// Cât așteaptă cererea din browser la „Adu AWB-urile acum".
const ADU_ASTEPT_MS = 25000;

// Ora României dintr-un timp ținut în UTC („2026-11-11 07:24:48").
function oraRo(utc) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(utc || ""));
  if (!m) return "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
}

// Ziua și ora României dintr-un timp ținut în UTC. Teancurile vin imediat după
// miezul nopții: citite în UTC ar apărea cu ziua de ieri, pe la 22.
function ziOraRo(utc) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(utc || ""));
  if (!m) return { zi: String(utc || "").slice(0, 10), ora: "" };
  const p = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])))
    .forEach((x) => { p[x.type] = x.value; });
  return { zi: `${p.year}-${p.month}-${p.day}`, ora: `${p.hour}:${p.minute}` };
}

// „11.11.2026 10:07" — ziua și ora României, gata de arătat.
function candRo(utc) {
  const ro = ziOraRo(utc);
  return `${dataRo(ro.zi)} ${ro.ora}`.trim();
}

// Căsuțele în care vin etichetele: cele care au primit deja un awbs.pdf. Până
// vine primul, căsuțele comune.
async function casuteAwb() {
  const cu = await db
    .prepare(
      `SELECT c.id, c.adresa, c.ultima_sincronizare, c.ultima_eroare,
              (SELECT COUNT(*) FROM email_mesaje m WHERE m.cont_id = c.id) AS mesaje
         FROM email_conturi c
        WHERE c.activ = 1
          AND EXISTS (SELECT 1 FROM email_mesaje m JOIN email_atasamente a ON a.mesaj_id = m.id
                       WHERE m.cont_id = c.id AND a.nume ILIKE 'awbs%.pdf')
        ORDER BY mesaje, c.id`
    )
    .all()
    .catch(() => []);
  if (cu.length) return cu;
  return db
    .prepare("SELECT id, adresa, ultima_sincronizare, ultima_eroare FROM email_conturi WHERE activ = 1 AND tip = 'comun' ORDER BY id")
    .all()
    .catch(() => []);
}

// Teancurile de etichete din ultimele `zile` zile, cu starea lor de printare.
//
// Acelasi fisier ajunge in doua casute (Sameday@ si office@ sunt amandoua pe
// email), deci acelasi drive_id apare de doua ori. Se tine o singura data —
// altfel s-ar printa de doua ori acelasi teanc.
async function etichetePdf(zile) {
  const de = new Date(Date.now() - nr(zile) * 86400000).toISOString().slice(0, 10);
  const randuri = await db
    .prepare(
      `SELECT a.id, a.nume, a.marime, a.drive_id, m.data,
              p.printat_la, p.automat, p.exemplare
         FROM email_atasamente a
         JOIN email_mesaje m ON m.id = a.mesaj_id
         LEFT JOIN ff_printari p ON p.atasament_id = a.id
        WHERE a.drive_id IS NOT NULL
          AND a.nume ILIKE 'awbs%.pdf'
          AND m.data >= ?
        ORDER BY m.data DESC, a.id DESC`
    )
    .all(de);
  const vazute = new Set();
  const out = [];
  for (const r of randuri) {
    if (vazute.has(r.drive_id)) continue;
    vazute.add(r.drive_id);
    const ro = ziOraRo(r.data);
    out.push({ ...r, zi: ro.zi, ora: ro.ora });
  }
  return out;
}

module.exports = { register, stocCurent, comenziZi, CALE, casuteAwb, oraRo, ziOraRo, candRo };
