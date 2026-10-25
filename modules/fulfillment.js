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
// explica. Când cineva întreabă „de unde au apărut 300 de topuri aici",
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
                    produse si stoc initial si aia e." Avea dreptate — la o
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
    // „q_<id>". Se iau doar cele completate: restul vin goale și nu înseamnă
    // „zero bucăți", ci „n-am numărat produsul ăsta". Diferența contează —
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
             scanez awb si sa fac doar test si roll back apoi."
             Un test pe altă bază n-ar fi spus nimic — abia pe datele reale
             se vede dacă AWB-ul tău chiar se recunoaște. */ ""}
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;margin:-4px 0 10px">
          <input type="checkbox" name="test" value="1"${deProba ? " checked" : ""}>
          <span><strong>Doar probă</strong> — scanez ca să văd ce iese, fără să ating stocul. Se poate șterge tot, dintr-un buton.</span>
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
    // drive nu în browser, ca să nu se încarce baza pe Render." Are dreptate:
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
  // „Sa fac doar test si roll back apoi." Un buton, nu o curățenie făcută cu
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
  // și un router care nu lasă pe nimeni înăuntru. Deci „automat" nu poate
  // însemna „serverul printează"; înseamnă „pagina asta, lăsată deschisă pe
  // calculatorul de lângă Zebra, se uită singură dacă a apărut ceva nou și
  // îl scoate la imprimantă". Asta chiar merge, și merge fără dialog dacă
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

    const randuri = fisiere.map((f) => [
      `<strong>${dataRo(f.zi)}</strong> <span style="color:var(--text-muted)">${esc(String(f.ora || ""))}</span>`,
      `<a href="${CALE}/etichete/${f.id}/pdf" target="_blank">${esc(f.nume)}</a>`,
      f.marime ? Math.round(nr(f.marime) / 1024).toLocaleString("ro-RO") + " KB" : "—",
      f.printat_la
        ? `<span class="badge verde">printat ${esc(String(f.printat_la).slice(0, 16))}</span>${
            f.automat ? " <span style=\"color:var(--text-muted);font-size:12px\">automat</span>" : ""
          }${nr(f.exemplare) > 1 ? ` <span style="color:var(--text-muted);font-size:12px">×${nr(f.exemplare)}</span>` : ""}`
        : '<span class="badge">neprintat</span>',
      `<button class="btn secondary" type="button" data-print="${f.id}">${f.printat_la ? "Printează din nou" : "Printează"}</button>`,
    ]);

    const body = `
      ${subtabs(`${CALE}/etichete`)}
      ${mesaje(ctx.query)}
      <h1 style="margin:6px 0 2px">Etichete AWB${
        neprintate ? ` — <span style="color:var(--warn)">${neprintate} ${neprintate === 1 ? "teanc neprintat" : "teancuri neprintate"}</span>` : ""
      }</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);font-size:13px;max-width:920px">
        Teancurile de etichete vin de la Sameday imediat după miezul nopții, câteva emailuri pe noapte, fiecare
        cu un <code>awbs.pdf</code>. Ele ajung singure în Drive; aici se vede doar ce-a ieșit la imprimantă și
        ce nu. Un teanc se printează întreg — nu se taie pe AWB-uri, ca să nu existe un al doilea loc în care
        se pot pierde etichete.
      </p>
      <div class="card" style="margin-bottom:14px;max-width:920px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:600">
          <input type="checkbox" id="auto"> Printează singur ce apare
        </label>
        <p style="margin:6px 0 0;font-size:13px;color:var(--text-muted)">
          Lasă fila asta deschisă pe calculatorul de lângă Zebra. Verifică din cinci în cinci minute și scoate
          teancurile noi. Ca să nu ceară de fiecare dată imprimanta, Chrome-ul de pe acel calculator trebuie
          pornit cu <code>--kiosk-printing</code>, iar Zebra să fie imprimanta implicită — altfel apare
          dialogul obișnuit de print. Bifa se ține pe calculatorul ăsta, nu pe cont.
        </p>
        <p style="margin:6px 0 0;font-size:13px" id="stare-auto"></p>
      </div>
      ${
        randuri.length
          ? table(["Ziua emailului", "Fișier", "Mărime", "Stare", ""], randuri)
          : "<p>N-a venit niciun teanc de etichete în ultimele două săptămâni.</p>"
      }
      <iframe id="tipar" style="position:fixed;width:0;height:0;border:0;left:-9999px"></iframe>
      <script>
      (function () {
        var sus = document.getElementById("stare-auto");
        var bifa = document.getElementById("auto");
        var cadru = document.getElementById("tipar");
        var ocupat = false;
        function spune(t) { sus.textContent = t; }
        try { bifa.checked = localStorage.getItem("ff-print-auto") === "1"; } catch (e) {}
        bifa.addEventListener("change", function () {
          try { localStorage.setItem("ff-print-auto", bifa.checked ? "1" : "0"); } catch (e) {}
          spune(bifa.checked ? "Pornit. Verific acum…" : "Oprit.");
          if (bifa.checked) verifica();
        });

        // Printarea unui teanc: se încarcă PDF-ul în cadrul ascuns, se dă
        // print, și abia DUPĂ aceea se scrie în ERP că a ieșit. Invers, o
        // pagină care cade între marcaj și imprimantă ar lăsa un teanc
        // marcat printat pe care nu l-a văzut nimeni.
        function printeaza(id) {
          return new Promise(function (gata, rau) {
            var ceas = setTimeout(function () { rau(new Error("PDF-ul nu s-a încărcat")); }, 60000);
            cadru.onload = function () {
              clearTimeout(ceas);
              try {
                cadru.contentWindow.focus();
                cadru.contentWindow.print();
                gata();
              } catch (e) { rau(e); }
            };
            cadru.src = ${JSON.stringify(CALE)} + "/etichete/" + id + "/pdf#toolbar=0";
          });
        }
        function marcheaza(id, automat, eroare) {
          return fetch(${JSON.stringify(CALE)} + "/etichete/" + id + "/printat", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ automat: automat ? 1 : 0, eroare: eroare || "" }),
          });
        }
        async function unul(id, automat) {
          try { await printeaza(id); await marcheaza(id, automat, ""); return true; }
          catch (e) { await marcheaza(id, automat, String(e && e.message || e)); return false; }
        }
        document.addEventListener("click", async function (ev) {
          var b = ev.target.closest("[data-print]");
          if (!b) return;
          b.disabled = true; b.textContent = "Se printează…";
          var ok = await unul(b.getAttribute("data-print"), false);
          b.textContent = ok ? "Printat" : "N-a mers";
          if (ok) setTimeout(function () { location.reload(); }, 1200);
          else b.disabled = false;
        });

        async function verifica() {
          if (!bifa.checked || ocupat) return;
          ocupat = true;
          try {
            var r = await fetch(${JSON.stringify(CALE)} + "/etichete/noi.json", { credentials: "same-origin", cache: "no-store" });
            var d = await r.json();
            if (!d.fisiere || !d.fisiere.length) {
              spune("Nimic nou. Ultima verificare " + new Date().toLocaleTimeString("ro-RO") + ".");
            } else {
              spune(d.fisiere.length + " teancuri noi, le scot la imprimantă…");
              var n = 0;
              for (var i = 0; i < d.fisiere.length; i++) { if (await unul(d.fisiere[i].id, true)) n++; }
              spune("Am printat " + n + " din " + d.fisiere.length + " la " + new Date().toLocaleTimeString("ro-RO") + ".");
              setTimeout(function () { location.reload(); }, 2500);
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

  router.get(`${CALE}/etichete/noi.json`, async (ctx) => {
    if (!ctx.user) return send(ctx.res, 403, "{}");
    const fisiere = (await etichetePdf(3)).filter((f) => !f.printat_la);
    ctx.res.writeHead(200, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ fisiere: fisiere.map((f) => ({ id: f.id, nume: f.nume, zi: f.zi })) }));
  });
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
    const d = String(r.data || "");
    out.push({ ...r, zi: d.slice(0, 10), ora: d.slice(11, 16) });
  }
  return out;
}

module.exports = { register, stocCurent, comenziZi, CALE };
