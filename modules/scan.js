"use strict";
// Scanarea: un cod de bare citit oriunde în ERP deschide lucrul care îl poartă.
//
// CE A CERUT VALI, 05.11.2026: „Să fie și cod de bare pe orice aviz sau
// etichetă, să poți scana produsul. Codul de bare e asociat cu fiecare cod de
// produs, comandă, AWB etc."
//
// Formele codurilor și scriptul care prinde cititorul pe orice pagină stau în
// lib/scan.js. Aici e căutarea: din textul scanat, toate lucrurile din ERP care
// îl poartă — produs, comandă, aviz, palet, comandă de producție, comandă la
// furnizor, AWB, transport.
//
//   • Un singur lucru găsit → se deschide direct, fără pagină intermediară:
//     omul a scanat paletul, vrea paletul.
//   • Mai multe → lista lor, omul alege. Nu ghicim: un cod de produs care arată
//     ca un aviz e o întâmplare rară, dar dacă ghicim greșit, omul ajunge pe
//     altă pagină și nu înțelege de ce.
//   • Nimic → o spunem, cu codul citit sub ochi: cel mai des e o etichetă
//     veche sau a altcuiva, și omul trebuie să vadă ce a citit cititorul.
//
// ACCESUL. Pagina de scanare e a tuturor (MEREU_PERMISE din lib/auth), dar ce
// deschide e după drepturile fiecăruia: un lucru găsit duce la prima lui
// pagină pe care omul o poate vedea (produsul: fișa lui, altfel stocul din
// CT-Park), iar dacă nu poate vedea niciuna, află doar că există.
//
// Camera telefonului: unde browserul are BarcodeDetector (Chrome pe Android),
// pagina are buton „Scanează cu camera" — un telefon din depozit devine
// cititor. Pe iPhone și pe calculatoarele fără el, butonul nu apare.
const db = require("../lib/db");
const SCAN = require("../lib/scan");
const codbare = require("../lib/codbare");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cant = (v, um) => `${nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""}`;
const semne = (lista) => lista.map(() => "?").join(", ");

// Cheile sub care poate sta un AWB scanat: el întreg și, dacă are la coadă
// numărul coletului („…001"), fără el. Doar litere și cifre — intră și într-un
// LIKE, unde „%" sau „_" ar însemna altceva.
function cheiAwb(brut) {
  const awb = SCAN.curataScanat(brut).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!awb) return [];
  const chei = [awb];
  if (awb.length > 11 && /\d{3}$/.test(awb)) chei.push(awb.slice(0, -3));
  return chei;
}

// ---- Ce se arată despre fiecare lucru găsit ---------------------------------
// { fel, titlu, detalii, unde: [{ url, cere }], cheie }. `unde` e în ordinea
// preferinței; `cere` e pagina pe care trebuie s-o poată vedea omul (implicit,
// chiar adresa, fără ce e după „?").

function gComanda(c) {
  return {
    fel: "Comandă de client",
    cheie: "comanda:" + c.id,
    titlu: `Comanda #${c.id}${text(c.numar) ? " · nr. " + text(c.numar) : ""}`,
    detalii: [c.client, text(c.data).slice(0, 10), c.status].filter(Boolean).join(" · "),
    unde: [{ url: `/comenzi/${c.id}` }],
  };
}

function gComandaFurnizor(c) {
  return {
    fel: "Comandă la furnizor",
    cheie: "cf:" + c.id,
    titlu: `Comanda ${text(c.numar) || "#" + c.id}`,
    detalii: [c.furnizor, text(c.data).slice(0, 10), c.status].filter(Boolean).join(" · "),
    unde: [{ url: `/procurement/comenzi/${c.id}` }],
  };
}

function gPalet(p) {
  return {
    fel: "Palet CT-Park",
    cheie: "palet:" + p.id,
    titlu: `Paletul ${p.cod}`,
    detalii: [
      p.marfa,
      nr(p.cantitate) ? cant(p.cantitate, p.um) : "",
      text(p.lot) ? "lot " + text(p.lot) : "",
      p.data_iesire ? "a ieșit pe " + text(p.data_iesire).slice(0, 10) : "în depozit",
    ]
      .filter(Boolean)
      .join(" · "),
    unde: [{ url: `/stocuri/ct-park/palet/${p.id}` }],
  };
}

function gProductie(c, forma) {
  const unde = forma && forma.operatie ? `operația ${String(forma.operatie).padStart(3, "0")}` : forma && forma.lot ? `lotul ${forma.lot}` : "";
  return {
    fel: "Comandă de producție",
    cheie: "productie:" + c.id,
    titlu: `Producția #${c.id}${text(c.numar) ? " · " + text(c.numar) : ""}`,
    detalii: [unde, c.tip_produs, c.client, c.status].filter(Boolean).join(" · "),
    unde: [{ url: `/productie/${c.id}` }],
  };
}

function gAviz(a) {
  return {
    fel: "Aviz",
    cheie: "aviz:" + a.id,
    titlu: `Avizul ${a.serie} ${a.numar}${Number(a.anulat) === 1 ? " (ANULAT)" : ""}`,
    detalii: [a.client_nume, text(a.data).slice(0, 10)].filter(Boolean).join(" · "),
    // Cine n-are bifa Avize, dar e la depozit, îl vede pe adresa depozitului —
    // aceeași foaie (modules/avize.js).
    unde: [{ url: `/avize/${a.id}` }, { url: `/stocuri/ct-park/aviz/${a.id}` }],
  };
}

function gProdus(p, nota) {
  const cod = text(p.cod) || text(p.cod_generat);
  return {
    fel: "Produs",
    cheie: "produs:" + p.id,
    titlu: p.denumire || "(fără denumire)",
    detalii: [cod ? "cod " + cod : `fără cod (P-${p.id})`, Number(p.activ) === 0 ? "inactiv" : "", nota || ""].filter(Boolean).join(" · "),
    // Fișa produsului e la Vânzări și Financiar; depozitul nu o are, dar are
    // stocul din CT-Park, unde produsul se vede cu paleții și locurile lui.
    unde: [
      { url: `/produse/${p.id}` },
      { url: `/stocuri/ct-park/stoc?q=${encodeURIComponent(cod || p.denumire || "")}`, cere: "/stocuri/ct-park/stoc" },
    ],
  };
}

function gAwb(awb, detalii) {
  return {
    fel: "AWB fulfillment",
    cheie: "awb:" + awb,
    titlu: `AWB ${awb}`,
    detalii,
    unde: [
      { url: `/scan/awb/${encodeURIComponent(awb)}`, cere: "/fulfillment" },
      { url: `/scan/awb/${encodeURIComponent(awb)}`, cere: "/rapoarte/comenzi-la-zi" },
    ],
  };
}

function gCursa(c) {
  return {
    fel: "Transport",
    cheie: "cursa:" + c.id,
    titlu: `Transportul #${c.id} · AWB ${text(c.awb)}`,
    detalii: [c.client, c.comanda_id ? `comanda #${c.comanda_id}` : "", text(c.data_livrare_ceruta).slice(0, 10), c.stare].filter(Boolean).join(" · "),
    unde: [{ url: `/logistica/cursa/${c.id}` }],
  };
}

// ---- Căutările, câte una pe formă (lib/scan.js → interpreteaza) -------------

const COLOANE_PRODUS = "id, cod, cod_generat, denumire, activ, fuzionat_in";

// Un produs unificat în altul trimite la cel păstrat: eticheta veche, cu codul
// vechi, tot trebuie să ducă undeva util.
async function produsUrmat(p) {
  let x = p;
  for (let pas = 0; pas < 5 && x && x.fuzionat_in; pas++) {
    const tinta = await db.prepare(`SELECT ${COLOANE_PRODUS} FROM produse WHERE id = ?`).get(x.fuzionat_in);
    if (!tinta) break;
    x = tinta;
  }
  return x === p ? gProdus(p) : gProdus(x, `codul ${text(p.cod) || "P-" + p.id} a fost unificat aici`);
}

async function paletiCu(conditie, ...valori) {
  return db
    .prepare(
      `SELECT p.id, p.cod, p.cantitate, p.um, p.lot, p.data_iesire, COALESCE(pr.denumire, p.produs_text) AS marfa
         FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
        WHERE ${conditie} ORDER BY p.id LIMIT 30`
    )
    .all(...valori);
}

const CAUTARI = {
  async comanda(f) {
    const c = await db
      .prepare(
        `SELECT c.id, c.numar, c.data, c.status, p.nume AS client
           FROM comenzi c LEFT JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?`
      )
      .get(f.id);
    return c ? [gComanda(c)] : [];
  },

  // Numărul scris pe comandă — de obicei al clientului, de pe hârtia lui — și
  // numărul unei comenzi la furnizor (CF-…, sau unul vechi, scris de mână).
  async numar_comanda(f) {
    const clienti = await db
      .prepare(
        `SELECT c.id, c.numar, c.data, c.status, p.nume AS client
           FROM comenzi c LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE LOWER(TRIM(c.numar)) = LOWER(?) ORDER BY c.id DESC LIMIT 10`
      )
      .all(f.numar);
    const furnizori = await CAUTARI.comanda_furnizor({ numar: f.numar });
    return clienti.map(gComanda).concat(furnizori);
  },

  async comanda_furnizor(f) {
    const r = await db
      .prepare(
        `SELECT cf.id, cf.numar, cf.data, cf.status, p.nume AS furnizor
           FROM comenzi_furnizor cf LEFT JOIN parteneri p ON p.id = cf.furnizor_id
          WHERE UPPER(TRIM(cf.numar)) = UPPER(?) ORDER BY cf.id DESC LIMIT 5`
      )
      .all(f.numar);
    return r.map(gComandaFurnizor);
  },

  async palet(f) {
    return (await paletiCu("UPPER(TRIM(p.cod)) = ?", f.cod)).map(gPalet);
  },

  // Lotul scris pe paleți (pe palet sau pe una dintre liniile lui): doar
  // paleții încă în depozit — cei plecați nu mai sunt de găsit pe raft.
  async lot(f) {
    const r = await paletiCu(
      `p.data_iesire IS NULL AND (UPPER(TRIM(p.lot)) = UPPER(?) OR EXISTS (
         SELECT 1 FROM ct_palet_linii pl WHERE pl.palet_id = p.id AND UPPER(TRIM(pl.lot)) = UPPER(?)))`,
      f.lot,
      f.lot
    );
    return r.map(gPalet);
  },

  async productie(f) {
    const c = await db
      .prepare(
        `SELECT cp.id, cp.numar, cp.tip_produs, cp.status, COALESCE(p.nume, cp.client_text) AS client
           FROM comenzi_productie cp LEFT JOIN parteneri p ON p.id = cp.partener_id WHERE cp.id = ?`
      )
      .get(f.id);
    return c ? [gProductie(c, f)] : [];
  },

  async aviz(f) {
    const r = await db
      .prepare("SELECT id, serie, numar, data, client_nume, anulat FROM avize WHERE UPPER(TRIM(serie)) = ? AND numar = ? ORDER BY id")
      .all(f.serie, f.numar);
    return r.map(gAviz);
  },

  async produs_id(f) {
    const p = await db.prepare(`SELECT ${COLOANE_PRODUS} FROM produse WHERE id = ?`).get(f.id);
    return p ? [await produsUrmat(p)] : [];
  },

  async produs(f) {
    let r = await db
      .prepare(
        `SELECT ${COLOANE_PRODUS} FROM produse
          WHERE LOWER(TRIM(cod)) = LOWER(?) OR LOWER(TRIM(cod_generat)) = LOWER(?)
          ORDER BY activ DESC, id LIMIT 10`
      )
      .all(f.cod, f.cod);
    if (!r.length) {
      // Codul de bare nu poartă diacritice și nici mai mult de 48 de caractere
      // (lib/codbare.js → curat): „FOLIE-Ș-20" se citește „FOLIE-S-20". Puținii
      // candidați — coduri cu litere în afara ASCII sau foarte lungi — se
      // compară aici, după aceeași curățare.
      const candidati = await db
        .prepare(
          `SELECT ${COLOANE_PRODUS} FROM produse
            WHERE cod ~ '[^ -~]' OR cod_generat ~ '[^ -~]' OR LENGTH(cod) > 48 OR LENGTH(cod_generat) > 48
            LIMIT 500`
        )
        .all()
        .catch(() => []);
      const t = String(f.cod).toLowerCase();
      r = candidati.filter((p) => [p.cod, p.cod_generat].some((c) => text(c) && codbare.curat(text(c)).toLowerCase() === t)).slice(0, 10);
    }
    const out = [];
    for (const p of r) out.push(await produsUrmat(p));
    return out;
  },

  async awb(f) {
    const chei = cheiAwb(f.awb);
    if (!chei.length) return [];
    const out = [];
    // AWB-urile Sameday (raportul zilnic, fulfillment, retururi): o singură
    // intrare, cu fișa lui pe /scan/awb.
    const sd = await db
      .prepare(
        `SELECT a.awb, z.data AS zi, cc.nume AS client FROM consumabile_awb a
           JOIN consumabile_zile z ON z.id = a.zi_id LEFT JOIN consumabile_clienti cc ON cc.id = a.client_id
          WHERE UPPER(a.awb) IN (${semne(chei)}) ORDER BY LENGTH(a.awb) DESC LIMIT 1`
      )
      .get(...chei);
    if (sd) out.push(gAwb(sd.awb, [sd.client, text(sd.zi).slice(0, 10)].filter(Boolean).join(" · ")));
    else {
      const ff = await db.prepare(`SELECT awb, zi, stare FROM ff_stare WHERE UPPER(awb) IN (${semne(chei)}) LIMIT 1`).get(...chei);
      const rt = ff
        ? null
        : await db
            .prepare(`SELECT awb FROM ff_retururi WHERE UPPER(awb) IN (${semne(chei)}) OR UPPER(awb) LIKE ? ORDER BY id DESC LIMIT 1`)
            .get(...chei, chei[0] + "___");
      if (ff) out.push(gAwb(ff.awb, ["fulfillment", text(ff.zi).slice(0, 10), ff.stare].filter(Boolean).join(" · ")));
      else if (rt) out.push(gAwb(chei[0], "retur în fulfillment"));
    }
    // AWB-ul unui transport din Logistică (curierul unei livrări de-a noastre).
    const curse = await db
      .prepare(
        `SELECT id, awb, client, comanda_id, data_livrare_ceruta, stare FROM transport_curse
          WHERE UPPER(TRIM(awb)) IN (${semne(chei)}) ORDER BY id DESC LIMIT 10`
      )
      .all(...chei);
    return out.concat(curse.map(gCursa));
  },
};

// Tot ce poartă codul. Întoarce { text, gasite }: textul curățat și lista,
// fără dubluri (CMD-142 iese și ca formă „comanda", și, dacă cineva a scris
// chiar „CMD-142" ca număr, ca „numar_comanda" — e aceeași comandă).
async function rezolva(brut) {
  const { text: t, forme } = SCAN.interpreteaza(brut);
  const gasite = [];
  const vazute = new Set();
  for (const f of forme) {
    const cauta = CAUTARI[f.fel];
    if (!cauta) continue;
    let lista = [];
    try {
      lista = await cauta(f);
    } catch (e) {
      // O căutare care cade (o tabelă lipsă pe o bază veche) nu le strică pe
      // celelalte: omul primește ce s-a găsit în rest.
      console.error(`[scan] ${f.fel}:`, e.message);
    }
    for (const g of lista || []) {
      if (vazute.has(g.cheie)) continue;
      vazute.add(g.cheie);
      gasite.push(g);
    }
  }
  return { text: t, gasite };
}

// Prima pagină a lucrului găsit pe care omul are voie s-o vadă, sau null.
function adresaPentru(user, g) {
  for (const u of g.unde || []) {
    const cere = u.cere || String(u.url).split("?")[0];
    if (poateAccesa(user, cere)) return u.url;
  }
  return null;
}

// ---- Paginile ------------------------------------------------------------------

const AJUTOR = `
  <details style="margin-top:18px;max-width:760px">
    <summary style="cursor:pointer;color:var(--text-muted)">Ce se poate scana</summary>
    <ul style="color:var(--text-muted);font-size:13px;line-height:1.6;margin-top:8px">
      <li><strong>Produsul</strong> — codul de pe aviz, de pe eticheta paletului sau de pe eticheta produsului (fără cod: P-12).</li>
      <li><strong>Comanda de client</strong> — CMD-142, de pe aviz și de pe eticheta de ieșire; sau numărul clientului, de pe hârtia lui.</li>
      <li><strong>Avizul</strong> — CHMA-1389, de sub numărul avizului.</li>
      <li><strong>Paletul</strong> — CT261105-0012, de pe eticheta lui; <strong>lotul</strong> de pe palet arată paleții cu el.</li>
      <li><strong>Producția</strong> — codul lotului și al operațiilor, de pe fișa de lot.</li>
      <li><strong>Comanda la furnizor</strong> — CF-2026-0001, de pe foaia comenzii.</li>
      <li><strong>AWB-ul</strong> — de pe eticheta curierului: coletele din fulfillment și transporturile din Logistică.</li>
    </ul>
    <p style="color:var(--text-muted);font-size:13px">Cu cititorul de coduri nu trebuie deschisă pagina asta: scanezi oriunde în ERP, cât timp nu ești într-un câmp de scris, și se deschide singur ce ai scanat.</p>
  </details>`;

function formular(valoare) {
  return `
    <form method="get" action="/scan" autocomplete="off" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;max-width:760px">
      <input name="cod" id="scan-cod" value="${esc(valoare || "")}" autofocus required placeholder="scanează sau scrie codul"
             style="flex:1 1 260px;font-size:20px;padding:10px 12px;font-family:ui-monospace,Menlo,Consolas,monospace">
      <button class="btn" type="submit">Caută</button>
      <button class="btn secondary" type="button" id="scan-camera" hidden>Scanează cu camera</button>
    </form>
    <div id="scan-video-cutie" hidden style="margin-top:12px;max-width:520px">
      <video id="scan-video" playsinline muted style="width:100%;border-radius:8px;background:#000"></video>
      <div style="margin-top:6px"><button type="button" class="btn secondary small" id="scan-opreste">Oprește camera</button></div>
    </div>
    <div id="scan-eroare" role="alert" style="color:var(--danger,#b91c1c);margin-top:8px"></div>
    ${/* „hidden" singur nu ajunge: .btn din style.css își pune propriul display,
         care bate regula browserului pentru [hidden] — butonul de cameră apărea
         și pe calculatoarele fără cameră, și nu făcea nimic. */ ""}
    <style>#scan-camera[hidden], #scan-video-cutie[hidden] { display:none !important; }</style>
    <script>
    (function () {
      // Câmpul se golește la fiecare încărcare a paginii cu un rezultat, ca
      // următoarea scanare să nu se lipească de cea de dinainte.
      var camp = document.getElementById("scan-cod");
      if (camp) { camp.focus(); camp.select(); }
      var buton = document.getElementById("scan-camera");
      if (!buton || !("BarcodeDetector" in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      // Unde API-ul există, dar nu citește coduri de bare liniare (o listă
      // goală de formate), butonul ar porni camera degeaba.
      if (typeof BarcodeDetector.getSupportedFormats === "function") {
        BarcodeDetector.getSupportedFormats()
          .then(function (f) { if (f && f.indexOf("code_128") !== -1) buton.hidden = false; })
          .catch(function () {});
      } else buton.hidden = false;
      var cutie = document.getElementById("scan-video-cutie");
      var video = document.getElementById("scan-video");
      var eroare = document.getElementById("scan-eroare");
      var flux = null, pornit = false;
      function opreste() {
        pornit = false;
        if (flux) flux.getTracks().forEach(function (t) { t.stop(); });
        flux = null;
        cutie.hidden = true;
      }
      document.getElementById("scan-opreste").addEventListener("click", opreste);
      buton.addEventListener("click", function () {
        eroare.textContent = "";
        var det;
        try { det = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "itf", "qr_code", "data_matrix"] }); }
        catch (e) { det = new BarcodeDetector(); }
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
          .then(function (s) { flux = s; video.srcObject = s; cutie.hidden = false; pornit = true; return video.play(); })
          .then(function () {
            (function pas() {
              if (!pornit) return;
              det.detect(video).then(function (coduri) {
                var cod = (coduri || []).map(function (x) { return x && x.rawValue; }).filter(Boolean)[0];
                if (cod) { opreste(); window.location.href = "/scan?cod=" + encodeURIComponent(cod); }
                else setTimeout(pas, 150);
              }).catch(function () { setTimeout(pas, 400); });
            })();
          })
          .catch(function (e) {
            opreste();
            eroare.textContent = "Camera nu pornește: " + ((e && e.message) || "fără acces la cameră") + ". Verifică permisiunea camerei pentru ERP în browser.";
          });
      });
    })();
    </script>`;
}

function paginaScan(ctx, { valoare, rezultat }) {
  send(ctx.res, 200, layout({ user: ctx.user, title: "Scanează", active: "/scan", body: formular(valoare) + (rezultat || "") + AJUTOR }));
}

// Fișa unui AWB Sameday: ce a cerut clientul, în ce zi, unde e în fulfillment
// și ce s-a întors. Pentru cine are fulfillment-ul sau raportul Sameday.
async function fisaAwb(ctx) {
  const vedeFf = poateAccesa(ctx.user, "/fulfillment");
  const vedeRaport = poateAccesa(ctx.user, "/rapoarte/comenzi-la-zi");
  if (!vedeFf && !vedeRaport) {
    return send(
      ctx.res,
      403,
      layout({ user: ctx.user, title: "Fără acces", active: "/scan", body: `<p>AWB-urile din fulfillment le văd cei cu acces la Fulfillment sau la raportul Sameday.</p><p><a href="/scan">Scanează altceva</a></p>` })
    );
  }
  const chei = cheiAwb(ctx.params.awb);
  if (!chei.length) return redirect(ctx.res, "/scan");
  const a = await db
    .prepare(
      `SELECT a.*, z.data AS zi, cc.nume AS client, cc.oras, cc.judet
         FROM consumabile_awb a JOIN consumabile_zile z ON z.id = a.zi_id
         LEFT JOIN consumabile_clienti cc ON cc.id = a.client_id
        WHERE UPPER(a.awb) IN (${semne(chei)}) ORDER BY LENGTH(a.awb) DESC LIMIT 1`
    )
    .get(...chei);
  const toate = [...new Set(chei.concat(a ? String(a.awb).toUpperCase() : []))];
  const linii = a
    ? await db
        .prepare(
          `SELECT cp.cod, cp.denumire, cp.um, al.cantitate FROM consumabile_awb_linii al
             JOIN consumabile_produse cp ON cp.id = al.produs_id WHERE al.awb_id = ? ORDER BY cp.ordine, cp.denumire`
        )
        .all(a.id)
    : [];
  const stare = await db.prepare(`SELECT * FROM ff_stare WHERE UPPER(awb) IN (${semne(toate)}) LIMIT 1`).get(...toate);
  // Returul se scrie cu ce a citit cititorul de pe colet, deci de obicei cu
  // numărul coletului la coadă: se caută și „AWB + trei caractere".
  const retururi = await db
    .prepare(
      `SELECT r.*, p.denumire FROM ff_retururi r LEFT JOIN produse p ON p.id = r.produs_id
        WHERE UPPER(r.awb) IN (${semne(toate)}) OR ${toate.map(() => "UPPER(r.awb) LIKE ?").join(" OR ")}
        ORDER BY r.id DESC LIMIT 20`
    )
    .all(...toate, ...toate.map((k) => k + "___"));
  // AWB-ul arătat: cel din raport sau din fulfillment, altfel cel scanat.
  const awb = a ? String(a.awb).toUpperCase() : stare ? String(stare.awb).toUpperCase() : chei[0];
  if (!a && !stare && !retururi.length) {
    return paginaScan(ctx, {
      valoare: chei[0],
      rezultat: `<div class="flash" style="margin-top:14px">AWB-ul ${esc(chei[0])} nu e în ERP: nici în raportul Sameday, nici în fulfillment.</div>`,
    });
  }
  const zi = text(a ? a.zi : stare && stare.zi).slice(0, 10);
  const linkuri = [
    vedeFf && zi ? `<a class="btn small" href="/fulfillment?zi=${esc(zi)}">Ziua în Fulfillment</a>` : "",
    vedeRaport && zi ? `<a class="btn small secondary" href="/rapoarte/comenzi-la-zi?zi=${esc(zi)}">Ziua în Comenzi Sameday</a>` : "",
    vedeRaport && a && a.client_id ? `<a class="btn small secondary" href="/rapoarte/comenzi-la-zi/client/${Number(a.client_id)}">Clientul</a>` : "",
    vedeFf && retururi.length ? `<a class="btn small secondary" href="/fulfillment/retururi">Retururi</a>` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = `
    <div class="detail-box">
      <div class="detail-grid">
        <div><div class="k">AWB</div><strong style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(awb)}</strong></div>
        <div><div class="k">Ziua</div>${esc(zi || "—")}</div>
        ${a ? `<div><div class="k">Client</div>${esc([a.client, a.oras, a.judet].filter(Boolean).join(", ") || "—")}</div>` : ""}
        ${a ? `<div><div class="k">Colete</div>${esc(String(a.colete || 1))}${nr(a.kg) ? ` · ${esc(cant(a.kg, "kg"))}` : ""}</div>` : ""}
        <div><div class="k">Fulfillment</div>${stare ? esc(stare.stare) + (stare.scanat_la ? ` · scanat ${esc(text(stare.scanat_la).slice(0, 16))}` : "") : "—"}</div>
      </div>
      <div style="margin:12px 0 4px">${codbare.svg(awb, { inalt: 12, modul: 0.33, latimeMax: 90 })}</div>
      ${linkuri ? `<div class="toolbar" style="margin-top:10px">${linkuri}</div>` : ""}
    </div>
    ${linii.length ? `<h2>Ce cere AWB-ul</h2>${table(["Cod", "Produs", "Cantitate"], linii.map((l) => [esc(l.cod), esc(l.denumire), esc(cant(l.cantitate, l.um))]))}` : ""}
    ${
      retururi.length
        ? `<h2>Retururi</h2>${table(
            ["Scanat", "Produs", "Cantitate", "Stare"],
            retururi.map((r) => [esc(text(r.scanat_la).slice(0, 16)), esc(r.denumire || "—"), r.cantitate === null ? "—" : esc(cant(r.cantitate)), esc(r.stare)])
          )}`
        : ""
    }
    <p style="margin-top:16px"><a href="/scan">Scanează altceva</a></p>`;
  send(ctx.res, 200, layout({ user: ctx.user, title: `AWB ${awb}`, active: "/scan", body }));
}

function register(router) {
  router.get("/scan", async (ctx) => {
    const brut = String((ctx.query && ctx.query.cod) || "");
    if (!SCAN.curataScanat(brut)) return paginaScan(ctx, { valoare: "" });

    const { text: t, gasite } = await rezolva(brut);
    const cuAdresa = gasite.map((g) => Object.assign({}, g, { adresa: adresaPentru(ctx.user, g) }));
    const deschise = cuAdresa.filter((g) => g.adresa);
    if (deschise.length === 1) return redirect(ctx.res, deschise[0].adresa);

    if (!cuAdresa.length) {
      console.log(`[scan] necunoscut: "${t}" (${(ctx.user && ctx.user.nume) || "?"})`);
      return paginaScan(ctx, {
        valoare: t,
        rezultat: `<div class="flash" style="margin-top:14px">Nu am găsit nimic cu codul <strong style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(t)}</strong>. Verifică dacă e o etichetă de-a noastră; dacă e, scrie codul de mână.</div>`,
      });
    }
    if (!deschise.length) {
      return paginaScan(ctx, {
        valoare: t,
        rezultat: `<div class="flash" style="margin-top:14px">Codul <strong>${esc(t)}</strong> e ${esc(
          cuAdresa.map((g) => `${g.fel.toLowerCase()} — ${g.titlu}`).join("; ")
        )}, dar n-ai acces la pagina lui.</div>`,
      });
    }
    const randuri = cuAdresa.map((g) => [
      esc(g.fel),
      g.adresa ? `<a href="${esc(g.adresa)}"><strong>${esc(g.titlu)}</strong></a>` : `<strong>${esc(g.titlu)}</strong>`,
      esc(g.detalii || ""),
      g.adresa ? `<a class="btn small" href="${esc(g.adresa)}">Deschide</a>` : '<span style="color:var(--text-muted)">n-ai acces</span>',
    ]);
    return paginaScan(ctx, {
      valoare: t,
      rezultat: `<p style="margin-top:16px">Codul <strong style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(t)}</strong> se potrivește la ${cuAdresa.length} lucruri. Alege:</p>
        ${table(["Ce e", "", "Detalii", ""], randuri)}`,
    });
  });

  router.get("/scan/awb/:awb", fisaAwb);
}

module.exports = { register, rezolva, adresaPentru, cheiAwb, CAUTARI };
