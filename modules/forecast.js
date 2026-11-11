"use strict";
// Procurement · Forecast de comandat.
//
// CE A CERUT VALI, 11.11.2026: „Vreau o pagină de forecast cu produse de
// comandat astfel încât să am stoc mereu, bazat pe istoric vânzări și comenzi
// în curs, care ar trebui, în funcție de rețete, să calculeze stocul consumat.
// Fă-o ca pe o pagină distinctă în Procurement."
//
// Socoteala e în lib/forecast-aprovizionare.js; aici e doar pagina.
//
// PAGINA VECHE. „Forecast aprovizionări" din Depozit (/depozit/forecast) lua
// stocul din mișcările vechi de stoc, nu din CT-Park, și nu știa de comenzile
// în curs: arăta stoc zero la materii prime care erau pe raft. Adresa ei
// rămâne, dar arată aceeași pagină ca cea din Procurement — două forecasturi
// cu cifre diferite ar fi mai rele decât unul.
const F = require("../lib/forecast-aprovizionare");
const { esc, layout, table } = require("../lib/render");
const { send } = require("../lib/router");

const nr = (v) => Number(v) || 0;

// Unitatea se lipește de cifră doar dacă chiar e o unitate: în catalog sunt
// produse la care în locul ei stă toată denumirea articolului.
function unitate(um) {
  const u = String(um || "").trim();
  return u && u.length <= 10 ? " " + esc(u) : "";
}
function cant(v, um) {
  const n = nr(v);
  const zecimale = Math.abs(n) < 100 && Math.abs(n % 1) > 0.0001 ? 2 : 0;
  return n.toLocaleString("ro-RO", { minimumFractionDigits: zecimale, maximumFractionDigits: zecimale }) + unitate(um);
}
const zileText = (n) => (n === 1 ? "o zi" : n + " zile");
// „2026-11-22" → „22.11.2026". Scris aici, nu lăsat pe seama layout-ului, ca
// data să fie românească și în atribute.
const dataRo = (zi) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(zi || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
};
// Cantitatea pentru adresa comenzii: cu punct, fără separatori de mii.
const pentruAdresa = (q) => String(Math.round(nr(q) * 100) / 100);

const STARE = {
  lipsa: ['<span class="badge rosu">lipsește acum</span>', "lipsește acum"],
  pe_drum: ['<span class="badge galben">acoperit doar cu ce e pe drum</span>', "acoperit doar cu ce e pe drum"],
  de_comandat: ['<span class="badge galben">de comandat</span>', "de comandat"],
  acoperit: ['<span class="badge verde">acoperit</span>', "acoperit"],
};

async function pagina(ctx, dinDepozit) {
  const q = ctx.query || {};
  const fereastra = F.FERESTRE.includes(Number(q.istoric)) ? Number(q.istoric) : F.FEREASTRA_IMPLICITA;
  const zile = F.ACOPERIRI.includes(Number(q.zile)) ? Number(q.zile) : F.ACOPERIRE_IMPLICITA;
  const toate = String(q.toate || "") === "1";
  const r = await F.forecast({ fereastra, zile, toate });
  const adresa = dinDepozit ? "/depozit/forecast" : "/procurement/forecast";
  const n = r.note;

  const deComandat = r.deCumparat.filter((x) => x.deComandat > 0);
  const lipsaAcum = r.deCumparat.filter((x) => x.stare === "lipsa");
  const curand = r.deCumparat.filter((x) => x.zileCuDrum != null && x.zileCuDrum <= 14);

  const selector = (nume, valoare, optiuni) =>
    `<select name="${nume}" onchange="this.form.submit()">${optiuni
      .map(([v, t]) => `<option value="${v}"${String(valoare) === String(v) ? " selected" : ""}>${esc(t)}</option>`)
      .join("")}</select>`;

  const ajunge = (x) => {
    if (x.zileStoc === 0) {
      const lipsesc = Math.max(0, x.inCurs - x.stoc);
      return `<strong style="color:var(--danger)">${x.stoc > 0 ? "nu ajunge" : "fără stoc"}</strong>${
        lipsesc > 0 ? `<div class="mic">lipsesc ${cant(lipsesc, x.um)} pentru comenzile în curs</div>` : ""
      }${
        x.vine > 0 ? `<div class="mic">cu ce e pe drum: ${x.zileCuDrum === 0 ? "tot nu ajunge" : x.zileCuDrum == null ? "peste un an" : "până la " + dataRo(x.dataCuDrum)}</div>` : ""
      }`;
    }
    if (x.zileStoc == null) return `<span style="color:var(--success)">peste un an</span>`;
    const culoare = x.zileStoc <= 14 ? "var(--danger)" : x.zileStoc <= r.zile ? "var(--warn,#b5760b)" : "var(--success)";
    return `<span style="color:${culoare}">${dataRo(x.dataStoc)}</span><div class="mic">în ${zileText(x.zileStoc)}</div>${
      x.vine > 0 && x.zileCuDrum !== x.zileStoc
        ? `<div class="mic">cu ce e pe drum: ${x.zileCuDrum == null ? "peste un an" : dataRo(x.dataCuDrum)}</div>`
        : ""
    }`;
  };

  const dinCe = (x) => {
    const bucati = x.dinCe.map((d) => `${esc(d.denumire)} ${Math.round(d.parte * 100)}%`);
    const rest = x.necesar > 0 ? x.direct / x.necesar : 0;
    if (rest > 0.005 && x.dinCe.length) bucati.push(`vândut ca atare ${Math.round(rest * 100)}%`);
    return bucati.length ? `<div class="mic">pentru: ${bucati.join(" · ")}</div>` : "";
  };

  const peDrum = (x) =>
    x.vine > 0
      ? `${cant(x.vine, x.um)}${x.vineDocumente
          .slice(0, 3)
          .map(
            (d) =>
              `<div class="mic">${d.document_id ? `<a href="/procurement/comenzi/${d.document_id}">${esc(d.document)}</a>` : esc(d.document)}${d.data ? " · " + dataRo(d.data) : " · fără dată"}</div>`
          )
          .join("")}`
      : "—";

  const stocCelula = (x) =>
    `${cant(x.stoc, x.um)}${
      x.stocAlteUm.length
        ? `<div class="mic" style="color:var(--warn,#b5760b)">mai sunt ${x.stocAlteUm.map((a) => cant(a.cantitate, a.um)).join(", ")} — altă unitate, nu intră în socoteală</div>`
        : ""
    }`;

  const furnizor = (x) => {
    if (x.furnizor && x.furnizor.nume) {
      return `${esc(x.furnizor.nume)}<div class="mic">${
        x.furnizor.pret != null ? `${x.furnizor.pret.toLocaleString("ro-RO", { maximumFractionDigits: 4 })} ${esc(x.furnizor.moneda || "")}${unitate(x.um) ? " /" + unitate(x.um) : ""} · ` : ""
      }${dataRo(x.furnizor.data)}</div>`;
    }
    return x.furnizoriStoc.length ? `<span class="mic">pe stoc de la: ${esc(x.furnizoriStoc.join(", "))}</span>` : "—";
  };

  const legaturaComanda = (x) =>
    `/procurement/comenzi/noua?linii=${x.produs_id}:${pentruAdresa(x.deComandat)}${x.furnizor && x.furnizor.id ? "&furnizor=" + x.furnizor.id : ""}`;

  const randuri = r.deCumparat.map((x) => [
    x.deComandat > 0
      ? `<input type="checkbox" class="fc-bifa" data-linie="${x.produs_id}:${pentruAdresa(x.deComandat)}" data-furnizor="${x.furnizor && x.furnizor.id ? x.furnizor.id : ""}" aria-label="pune în comandă">`
      : "",
    `<a href="/produse/${x.produs_id}">${esc(x.denumire)}</a>${x.cod ? ` <span class="mic">(${esc(x.cod)})</span>` : ""}${dinCe(x)}${
      x.marfa ? "" : '<div class="mic" style="color:var(--warn,#b5760b)">fără categorie și fără gestiune — poate fi un serviciu</div>'
    }${x.inactiv ? '<div class="mic" style="color:var(--warn,#b5760b)">scos din catalog</div>' : ""}`,
    esc(x.categorie || x.gestiune || "—"),
    cant(x.consumLuna, x.um),
    x.inCurs > 0 ? cant(x.inCurs, x.um) : "—",
    stocCelula(x),
    peDrum(x),
    ajunge(x),
    x.deComandat > 0
      ? `<strong>${cant(x.deComandat, x.um)}</strong><div class="mic"><a href="${esc(legaturaComanda(x))}">comandă →</a></div>`
      : '<span style="color:var(--text-muted)">—</span>',
    STARE[x.stare][0],
    furnizor(x),
  ]);

  const acoperire = n.acoperire || {};
  const parteFara = acoperire.valoare > 0 ? acoperire.valoareFara / acoperire.valoare : 0;
  const atentionari = [];
  if (parteFara > 0.02) {
    atentionari.push(
      `<strong>${Math.round(parteFara * 100)}% din ce s-a facturat în ultimele ${fereastra} de zile e pe linii fără produs din catalog</strong>
       (${acoperire.liniiFara.toLocaleString("ro-RO")} din ${acoperire.linii.toLocaleString("ro-RO")} linii). Vânzările alea nu se pot desface în materie primă,
       deci consumul real e mai mare decât cel de aici.`
    );
  }
  if (n.productieFaraProdus > 0) {
    atentionari.push(
      `${n.productieFaraProdus === 1 ? "O comandă de producție în curs e scrisă" : n.productieFaraProdus + " comenzi de producție în curs sunt scrise"} doar ca text, fără produs din catalog:
       ${n.productieFaraProdus === 1 ? "n-are rețetă de urmat, deci materia ei primă nu e socotită" : "n-au rețetă de urmat, deci materia lor primă nu e socotită"}. <a href="/productie">Vezi producția</a>.`
    );
  }
  if (n.stocFaraProdus > 0) {
    atentionari.push(
      `${n.stocFaraProdus === 1 ? "O marfă din depozit e scrisă" : n.stocFaraProdus + " mărfuri din depozit sunt scrise"} liber, fără produs din catalog: stocul lor nu se poate lega de nicio rețetă,
       deci nu e socotit. Se leagă de produs din fișa paletului, la „Corectează marfa de pe palet”.`
    );
  }
  if (n.cuAltaUnitate > 0) {
    atentionari.push(
      `La ${n.cuAltaUnitate === 1 ? "un articol" : n.cuAltaUnitate + " articole"} stocul din depozit e scris în altă unitate de măsură decât cea a produsului și nu intră în socoteală
       (scrie pe rând, la „Stoc”). Se îndreaptă din fișa paletului, la „Corectează marfa de pe palet”.`
    );
  }
  if (n.cercuri.length) {
    atentionari.push(
      `Rețete care se învârt în cerc (un produs făcut din el însuși, prin altele) — legătura a fost sărită:
       ${n.cercuri.slice(0, 5).map((c) => `${esc(c.produs)} ← ${esc(c.componenta)}`).join("; ")}.`
    );
  }

  // Submeniul (Procurement sau Depozit, după adresă) îl pune layout-ul.
  const body = `
    <p class="explic" style="max-width:980px">
      Ce e de comandat ca să fie mereu stoc. Pentru fiecare lucru pe care îl cumpărăm:
      <strong>de comandat = comenzile în curs + consumul pe ${r.zile} de zile − stocul − ce e pe drum</strong>.
      Consumul vine din ce s-a facturat în ultimele ${r.fereastra} de zile; la produsele făcute de noi, vânzările și comenzile se desfac
      prin rețete în materie primă, după ce se scade ce există deja ca produs finit și ce e deja în producție.
      Comenzile în curs sunt comenzile clienților nelivrate și producția care n-are comandă de client în ERP.
    </p>

    <form method="get" action="${adresa}" class="filtre" style="align-items:center">
      <label>Istoric ${selector("istoric", fereastra, F.FERESTRE.map((v) => [v, "ultimele " + v + " de zile"]))}</label>
      <label>Acoperire ${selector("zile", zile, F.ACOPERIRI.map((v) => [v, v + " de zile de stoc"]))}</label>
      ${
        n.faraIncadrare > 0 || toate
          ? `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="toate" value="1"${toate ? " checked" : ""} onchange="this.form.submit()">
               și ${n.faraIncadrare === 1 ? "articolul" : "cele " + n.faraIncadrare + " articole"} fără categorie și fără gestiune (servicii, de regulă)</label>`
          : ""
      }
    </form>

    <div class="cards">
      <div class="card"><div class="label">De comandat</div>
        <div class="value" style="color:${deComandat.length ? "var(--danger)" : "var(--success)"}" id="fc-de-comandat">${deComandat.length}</div>
        <div class="mic">din ${r.deCumparat.length} articole urmărite, pentru ${r.zile} de zile de stoc</div></div>
      <div class="card"><div class="label">Lipsesc pentru comenzile în curs</div>
        <div class="value" style="color:${lipsaAcum.length ? "var(--danger)" : "var(--success)"}" id="fc-lipsa">${lipsaAcum.length}</div>
        <div class="mic">nici cu ce e pe drum nu ajung</div></div>
      <div class="card"><div class="label">Se termină în 14 zile</div>
        <div class="value" style="color:${curand.length ? "var(--warn,#b5760b)" : "var(--success)"}" id="fc-curand">${curand.length}</div>
        <div class="mic">cu tot cu ce e pe drum</div></div>
      <div class="card"><div class="label">Din ce e socotit</div>
        <div class="mic" style="font-size:13px;line-height:1.6">${n.produseVandute} produse vândute în ${r.fereastra} de zile, ${n.cuReteta} cu rețetă<br>
          ${n.comenziClienti} ${n.comenziClienti === 1 ? "comandă de client" : "comenzi de clienți"} în curs<br>
          ${n.productiiInCurs} ${n.productiiInCurs === 1 ? "producție în curs" : "producții în curs"}</div></div>
    </div>

    ${atentionari.map((a) => `<div class="detail-box" style="border-left:4px solid var(--warn);margin-bottom:8px;font-size:13px">${a}</div>`).join("")}

    <h2 style="margin-top:18px">De cumpărat</h2>
    <p class="explic">Materia primă și marfa de revânzare. Cele mai grabnice sus. Bifează ce vrei să comanzi și apasă butonul de sub tabel:
      se deschide o comandă nouă la furnizor, cu produsele și cantitățile puse.</p>
    ${table(
      ['<input type="checkbox" id="fc-toate" aria-label="bifează tot ce e de comandat">', "Articol", "Categorie", "Consum / lună", "Comenzi în curs", "Stoc", "Pe drum", "Stocul ajunge până la", `De comandat (${r.zile} zile)`, "Stare", "Ultimul furnizor"],
      randuri,
      { filtre: "forecast-comandat" }
    )}
    ${
      r.deCumparat.length
        ? `<div class="form-actions" style="margin-top:10px">
             <button type="button" class="btn" id="fc-comanda" disabled>Fă o comandă la furnizor cu cele bifate →</button>
             <span class="mic" id="fc-cate">niciun articol bifat</span>
           </div>`
        : `<p>Nimic de urmărit: în ultimele ${r.fereastra} de zile nu s-a facturat niciun produs din catalog și nu e nicio comandă în curs.</p>`
    }

    <h2 style="margin-top:26px">De făcut în producție</h2>
    <p class="explic">De aici vine cererea de materie primă: produsele cu rețetă din care trebuie făcut mai mult decât există.
      „De făcut” = comenzile în curs + consumul pe ${r.zile} de zile − stoc − ce e deja în producție (dar nu mai puțin decât producția planificată și neîncepută).</p>
    ${table(
      ["Produs", "Consum / lună", "Comenzi în curs", "Stoc", "În producție", "Planificat, neînceput", `De făcut (${r.zile} zile)`],
      r.deProdus.slice(0, 200).map((x) => [
        `<a href="/produse/${x.produs_id}">${esc(x.denumire)}</a>${x.cod ? ` <span class="mic">(${esc(x.cod)})</span>` : ""}${
          x.inactiv ? '<div class="mic" style="color:var(--warn,#b5760b)">scos din catalog</div>' : ""
        }`,
        cant(x.consumLuna, x.um),
        x.inCurs > 0
          ? `${cant(x.inCurs, x.um)}<div class="mic">${x.documente
              .slice(0, 4)
              .map((d) => `${d.fel === "comanda" && d.document_id ? `<a href="/comenzi/${d.document_id}">${esc(d.document)}</a>` : esc(d.document)}${d.client ? " " + esc(d.client) : ""}`)
              .join(" · ")}${x.documente.length > 4 ? ` · încă ${x.documente.length - 4}` : ""}</div>`
          : "—",
        cant(x.stoc, x.um),
        x.inProductie > 0 ? cant(x.inProductie, x.um) : "—",
        x.neinceput > 0 ? cant(x.neinceput, x.um) : "—",
        `<strong>${cant(x.deFacut, x.um)}</strong>`,
      ])
    )}
    ${r.deProdus.length > 200 ? `<p class="mic">Se arată primele 200 din ${r.deProdus.length}.</p>` : ""}

    <style>
      table[data-filtre="forecast-comandat"] td { vertical-align: top; }
      table[data-filtre="forecast-comandat"] td:nth-child(2) { min-width: 220px; white-space: normal; }
      table[data-filtre="forecast-comandat"] th { white-space: normal; vertical-align: bottom; }
    </style>
    <script>
    // Bifele: comanda la furnizor se deschide cu produsele și cantitățile puse.
    (function () {
      var buton = document.getElementById("fc-comanda"), cate = document.getElementById("fc-cate"), tot = document.getElementById("fc-toate");
      if (!buton) return;
      function bifate() { return [].filter.call(document.querySelectorAll(".fc-bifa"), function (b) { return b.checked; }); }
      function arata() {
        var b = bifate();
        buton.disabled = !b.length;
        cate.textContent = b.length ? (b.length === 1 ? "un articol bifat" : b.length + " articole bifate") : "niciun articol bifat";
      }
      document.addEventListener("change", function (ev) {
        if (ev.target === tot) {
          // Doar rândurile care se văd: cele ascunse de filtre nu se bifează pe nevăzute.
          [].forEach.call(document.querySelectorAll(".fc-bifa"), function (b) { if (b.closest("tr").style.display !== "none") b.checked = tot.checked; });
        }
        if (ev.target === tot || (ev.target.classList && ev.target.classList.contains("fc-bifa"))) arata();
      });
      buton.addEventListener("click", function () {
        var b = bifate();
        if (!b.length) return;
        var linii = b.map(function (x) { return x.getAttribute("data-linie"); }).join(";");
        // Furnizorul se pune singur doar dacă toate cele bifate au același ultim furnizor.
        var furnizori = {};
        b.forEach(function (x) { furnizori[x.getAttribute("data-furnizor") || ""] = 1; });
        var unul = Object.keys(furnizori);
        var adresa = "/procurement/comenzi/noua?linii=" + encodeURIComponent(linii);
        if (unul.length === 1 && unul[0]) adresa += "&furnizor=" + encodeURIComponent(unul[0]);
        window.location.href = adresa;
      });
      arata();
    })();
    </script>
  `;
  send(ctx.res, 200, layout({ user: ctx.user, title: "Forecast de comandat", active: adresa, body }));
}

function register(router) {
  router.get("/procurement/forecast", (ctx) => pagina(ctx, false));
  router.get("/depozit/forecast", (ctx) => pagina(ctx, true));
}

module.exports = { register };
