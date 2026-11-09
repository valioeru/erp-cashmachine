"use strict";
// „Stoc la zi" pe produse, cu rezervările agenților. Pagina e a tuturor celor
// logați — singura din Depozit pe care o vede oricine (lib/auth, PAGINI_AGENT).
//
// Vali, 09.11.2026: „o pagină la agenții de vânzări și nu numai cu stoc la zi
// … asta cu stocul să fie în Depozit, în principal, și userii să aibă acces la
// această pagină, nu la tot depozitul."
//
// Socoteala stocului e în lib/stoc-produse.js, regulile rezervărilor în
// lib/rezervari-agenti.js. Aici e doar ce se vede.
//
// Vederea veche, pe paleți (lot, loc, furnizor, preț), rămâne la
// /stocuri/ct-park/stoc?vedere=paleti — modules/ct-park.js o desenează și ea
// trimite aici tot restul.

const db = require("../lib/db");
const { esc, layout, table, cautaClient, cautaClientScript, randuriClienti } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");
const SP = require("../lib/stoc-produse");
const RA = require("../lib/rezervari-agenti");

const STOC = "/stocuri/ct-park/stoc";
const REZERVARI = "/stocuri/ct-park/stoc/rezervari";

// Categoriile paleților, în ordinea din depozit (modules/ct-park.js, CATEGORII).
const TIPURI = ["produse finite", "produse intermediare", "consumabile", "materie primă"];
const FARA_TIP = "(fără categorie)";

const ARATA = {
  liber: { eticheta: "Cu stoc liber", potrivit: (r) => r.disponibil > SP.EPS },
  rezervat: { eticheta: "Rezervate", potrivit: (r) => r.rezervari.length > 0 },
  promis: { eticheta: "Promise pe comenzi", potrivit: (r) => r.promis > SP.EPS },
  intra: { eticheta: "Urmează să intre", potrivit: (r) => r.intrari.length > 0 },
};

const cant = (v) => (Number(v) || 0).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const cu = (v, um) => `${cant(v)}${um ? " " + esc(um) : ""}`;
// Rândurile mărunte de sub cifre. Lățimea e ținută în frâu ca tabelul să nu
// se întindă cât cel mai lung rând de detalii.
const mic = (html, stil) => `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;max-width:340px;white-space:normal${stil ? ";" + stil : ""}">${html}</div>`;
const dataRo = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
};
const fara = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

// Întoarcerea după un POST: doar spre paginile de stoc, nu spre o adresă
// venită din formular — altfel formularul ar putea trimite omul oriunde.
function inapoiSigur(v) {
  const s = String(v || "");
  return s === STOC || s.startsWith(STOC + "?") || s === REZERVARI || s.startsWith(REZERVARI + "?") ? s : STOC;
}
function cuMesaj(url, cheie, text) {
  const [cale, qs] = String(url).split("?");
  const p = new URLSearchParams(qs || "");
  p.delete("ok");
  p.delete("eroare");
  p.set(cheie, String(text || ""));
  return `${cale}?${p.toString()}`;
}

function cutieMesaj(q) {
  const ok = q && q.ok ? String(q.ok) : "";
  const er = q && q.eroare ? String(q.eroare) : "";
  return (
    (ok ? `<div class="detail-box" style="border-left:4px solid var(--success,#15803d);max-width:900px;margin:8px 0">${esc(ok)}</div>` : "") +
    (er ? `<div class="detail-box" style="border-left:4px solid var(--danger,#b91c1c);max-width:900px;margin:8px 0" role="alert"><strong>${esc(er)}</strong></div>` : "")
  );
}

function linkDoc(user, href, text) {
  return poateAccesa(user, href) ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

function formElibereaza(z, inapoi) {
  return `<details class="elibereaza" style="margin-top:3px">
      <summary style="cursor:pointer;font-size:12px;color:var(--primary,#2f5d9c)">Eliberează</summary>
      <form method="post" action="${REZERVARI}/${z.id}/elibereaza" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <input type="hidden" name="inapoi" value="${esc(inapoi)}">
        <input type="text" name="motiv" required minlength="3" maxlength="500" placeholder="motivul (obligatoriu)" style="min-width:200px;font-size:13px">
        <button class="btn small" type="submit">Eliberează rezervarea</button>
      </form>
    </details>`;
}

// O rezervare, cum o citește oricine: „rezervat de agentul Y pentru clientul X".
function textRezervare(z, um) {
  return `rezervat de agentul <strong>${esc(z.agent || "?")}</strong> pentru clientul <strong>${esc(z.client || "?")}</strong>: ${cu(
    z.cantitate,
    z.um || um
  )}, până la ${esc(RA.dataOra(z.expira_la))}${z.observatii ? ` <span style="color:var(--text-muted)">· ${esc(z.observatii)}</span>` : ""}`;
}

function celule(r, ctx, inapoi, poateRez) {
  const user = ctx.user;
  const produs =
    `<strong>${esc(r.denumire)}</strong>` +
    mic([r.cod ? esc(r.cod) : "", r.familie ? esc(r.familie) : ""].filter(Boolean).join(" · ") || "&nbsp;") +
    (r.loturi.length && r.loturi.length <= 3 ? mic("lot " + esc(r.loturi.join(", "))) : r.loturi.length > 3 ? mic(`${r.loturi.length} loturi`) : "") +
    // Furnizorii de pe paleți: doar pentru cine are Depozitul (rândul îi are
    // numai atunci — lib/stoc-produse.js).
    (r.furnizori.length ? mic("furnizor: " + esc(r.furnizori.join(", "))) : "");

  const inStoc =
    r.stoc > SP.EPS
      ? `${cu(r.stoc, r.um)}${mic(`${r.paleti} ${r.paleti === 1 ? "palet" : "paleți"}${r.ultima_intrare ? " · ultima intrare " + dataRo(r.ultima_intrare) : ""}`)}`
      : `0${r.um ? " " + esc(r.um) : ""}`;
  const alte = r.alteUm.length ? mic("și " + r.alteUm.map((a) => cu(a.cantitate, a.um)).join(", ") + " (altă unitate, separat)") : "";

  const promis = r.promis > SP.EPS
    ? cu(r.promis, r.um) +
      r.promisPe
        .map((p) =>
          mic(
            `${esc(p.client)}: ${cu(p.cantitate, r.um)}${
              p.comenzi.length ? " — " + p.comenzi.map((c) => linkDoc(user, `/comenzi/${c.comanda_id}`, c.numar)).join(", ") : ""
            }${p.facutPentru ? ` — făcut pentru el${p.productii.length ? " (producția " + p.productii.map(esc).join(", ") + ")" : ""}` : ""}`
          )
        )
        .join("")
    : "—";

  const rezervat = r.rezervat > SP.EPS ? cu(r.rezervat, r.um) : "—";

  const disponibil =
    (r.disponibil > SP.EPS
      ? `<strong style="color:var(--success,#15803d)">${cu(r.disponibil, r.um)}</strong>`
      : `<strong style="color:var(--danger,#b91c1c)">0${r.um ? " " + esc(r.um) : ""}</strong>`) +
    (r.depasit > SP.EPS ? mic(`lipsesc ${cu(r.depasit, r.um)} pentru ce e promis și rezervat`, "color:var(--danger,#b91c1c)") : "");

  const stare =
    `<strong>${esc(r.stare)}</strong>` +
    r.rezervari
      .map(
        (z) =>
          `<div style="font-size:12px;margin-top:4px;max-width:380px;white-space:normal">${textRezervare(z, r.um)}${RA.poateElibera(user, z) ? formElibereaza(z, inapoi) : ""}</div>`
      )
      .join("");

  const intra = r.intrari.length
    ? (r.inDrum > SP.EPS ? cu(r.inDrum, r.um) : `<span style="color:var(--text-muted)">0${r.um ? " " + esc(r.um) : ""} liber</span>`) +
      r.intrari
        .map((i) => {
          const q = cu(i.cantitate, i.um);
          if (i.fel === "furnizor") {
            return mic(
              `${q} · comandat la furnizor${i.furnizor ? " " + esc(i.furnizor) : ""} (${linkDoc(user, `/procurement/comenzi/${i.document_id}`, i.document)})${
                i.data ? " · sosește " + dataRo(i.data) : " · fără dată de sosire"
              }`
            );
          }
          const unde = i.stare === "finalizata" || i.stare === "facturata" ? "gata în producție, de preluat în depozit" : "în producție";
          return mic(
            `${q} · ${unde} (${linkDoc(user, `/productie/${i.document_id}`, i.document)})${i.data ? " · termen " + dataRo(i.data) : ""}${
              i.client ? ` · <strong>pentru ${esc(i.client)}</strong>${i.comanda_numar ? ", comanda " + esc(i.comanda_numar) : ""}` : ""
            }`,
            i.client ? "" : "color:inherit"
          );
        })
        .join("")
    : "—";

  const actiune =
    poateRez && r.produs_id
      ? `<button type="button" class="btn small" data-rezerva
           data-produs="${r.produs_id}" data-nume="${esc(r.denumire)}" data-cod="${esc(r.cod)}"
           data-liber="${r.disponibil}" data-um="${esc(r.um)}"${r.disponibil > SP.EPS ? "" : ' disabled title="Nu e nimic liber de rezervat"'}${
             r.disponibil > SP.EPS ? "" : ' style="opacity:.45;cursor:not-allowed"'
           }>Rezervă</button>`
      : "";

  // Butonul „Rezervă" stă sub cifra liberă: e cifra după care se hotărăște,
  // și rămâne la vedere și când tabelul e mai lat decât ecranul.
  return [
    produs,
    esc(r.tip || "—"),
    inStoc + alte,
    disponibil + (actiune ? `<div style="margin-top:4px">${actiune}</div>` : ""),
    stare,
    promis,
    rezervat,
    intra,
    r.sosire ? dataRo(r.sosire) : "—",
    esc(r.categorie || "—"),
  ];
}

async function pagina(ctx, opt) {
  const user = ctx.user;
  const q = ctx.query || {};
  const vedeTot = poateAccesa(user, "/stocuri/ct-park");
  const poateIntra = poateAccesa(user, "/stocuri/ct-park/intrare");
  const poateRez = RA.poateRezerva(user);

  await RA.actualizeaza().catch((e) => console.error("[stoc-la-zi] actualizare rezervari:", e.message));
  const toate = await SP.citeste({ vedeTot });

  const cauta = String(q.q || "").trim();
  const tip = String(q.tip || "");
  const arata = ARATA[String(q.arata || "")] ? String(q.arata) : "";
  const tipRand = (r) => (TIPURI.includes(r.tip) ? r.tip : FARA_TIP);
  const bucati = fara(cauta).split(/\s+/).filter(Boolean);
  const dupaCautare = toate.filter((r) => {
    if (!bucati.length) return true;
    const t = SP.textCautare(r);
    return bucati.every((b) => t.includes(b));
  });
  const dupaTip = dupaCautare.filter((r) => !tip || tipRand(r) === tip);
  const vizibile = dupaTip.filter((r) => !arata || ARATA[arata].potrivit(r));

  const urlCu = (schimb) => {
    const p = new URLSearchParams();
    const v = Object.assign({ q: cauta, tip, arata }, schimb);
    for (const k of ["q", "tip", "arata"]) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return STOC + (s ? "?" + s : "");
  };
  const inapoi = urlCu({});

  const chip = (activ, href, text, n) =>
    `<a href="${esc(href)}" class="subnav-link${activ ? " activ" : ""}" style="font-size:13px">${esc(text)}${
      n === undefined ? "" : ` <span style="opacity:.7">(${n})</span>`
    }</a>`;
  const tipuriPrezente = TIPURI.concat([FARA_TIP]).filter((t) => dupaCautare.some((r) => tipRand(r) === t));
  const chipsTip = `<div class="subnav" style="margin:6px 0 0;flex-wrap:wrap" aria-label="Categorie">
      <span style="font-size:12px;color:var(--text-muted);align-self:center;margin-right:4px">Categorie:</span>
      ${chip(!tip, urlCu({ tip: "" }), "Toate", dupaCautare.length)}
      ${tipuriPrezente.map((t) => chip(tip === t, urlCu({ tip: t }), t, dupaCautare.filter((r) => tipRand(r) === t).length)).join("")}
    </div>`;
  const chipsArata = `<div class="subnav" style="margin:4px 0 8px;flex-wrap:wrap" aria-label="Arată">
      <span style="font-size:12px;color:var(--text-muted);align-self:center;margin-right:4px">Arată:</span>
      ${chip(!arata, urlCu({ arata: "" }), "Tot")}
      ${Object.entries(ARATA).map(([k, a]) => chip(arata === k, urlCu({ arata: k }), a.eticheta, dupaTip.filter(a.potrivit).length)).join("")}
    </div>`;

  const cuStoc = toate.filter((r) => r.stoc > SP.EPS);
  const cards = `<div class="cards">
      <div class="card"><div class="label">Produse pe stoc</div><div class="value">${cuStoc.length}</div>
        <div class="ct-sub">pe ${cuStoc.reduce((s, r) => s + r.paleti, 0)} paleți în CT-Park</div></div>
      <div class="card"><div class="label">Cu stoc liber</div><div class="value">${toate.filter(ARATA.liber.potrivit).length}</div>
        <div class="ct-sub">după comenzi și rezervări</div></div>
      <div class="card"><div class="label">Rezervări active</div><div class="value">${toate.reduce((s, r) => s + r.rezervari.length, 0)}</div>
        <div class="ct-sub"><a href="${REZERVARI}">vezi toate rezervările</a></div></div>
      <div class="card"><div class="label">Urmează să intre</div><div class="value">${toate.filter(ARATA.intra.potrivit).length}</div>
        <div class="ct-sub">produse comandate sau în producție</div></div>
    </div>`;

  // Panoul de rezervare: unul singur pe pagină, umplut de butonul „Rezervă"
  // al rândului. Lista de clienți pleacă o dată, ca date (lib/render).
  let panou = "";
  let scriptClienti = "";
  if (poateRez) {
    const parteneri = await db.prepare("SELECT id, nume, cui, agent_id FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    const agenti = await db.prepare("SELECT id, nume FROM utilizatori ORDER BY nume").all();
    const mentiuni = await require("./scadente").mentiuniClienti().catch(() => null);
    scriptClienti = cautaClientScript(randuriClienti(parteneri, agenti, mentiuni));
    panou = `
      <div id="panou-rezervare" class="detail-box" hidden style="border-left:4px solid var(--primary,#2f5d9c);max-width:900px;margin:10px 0">
        <form method="post" action="${STOC}/rezerva" id="form-rezervare">
          <input type="hidden" name="produs_id" value="">
          <input type="hidden" name="inapoi" value="${esc(inapoi)}">
          <h3 style="margin:0 0 2px">Rezervă: <span data-produs-nume></span></h3>
          <p style="margin:0 0 10px;font-size:13px;color:var(--text-muted)">
            Liber acum: <strong data-liber></strong>. Rezervarea ține <strong>3 zile</strong>. Dacă în timpul ăsta clientul
            nu pune comanda cu produsul ăsta, se eliberează singură. Clienții cu facturi restante nu pot primi rezervări.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px;align-items:end">
            <label style="display:block">Client <b>*</b>
              ${cautaClient({ nume: "client_text", obligatoriu: true, placeholder: "scrie 2-3 litere din nume sau CUI" })}
            </label>
            <label style="display:block">Cantitate <b>*</b> <span data-um style="color:var(--text-muted)"></span>
              <input type="text" name="cantitate" inputmode="decimal" autocomplete="off" required style="width:100%">
            </label>
            <label style="display:block">Observații
              <input type="text" name="observatii" maxlength="300" placeholder="opțional" style="width:100%">
            </label>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn" type="submit">Rezervă 3 zile</button>
            <button class="btn secondary" type="button" data-renunta>Renunță</button>
          </div>
        </form>
      </div>
      <script>
        (function () {
          var panou = document.getElementById("panou-rezervare");
          if (!panou) return;
          var f = panou.querySelector("form");
          function cant(v) { return Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 }); }
          document.addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("[data-rezerva]") : null;
            if (b && !b.disabled) {
              f.querySelector('input[name="produs_id"]').value = b.getAttribute("data-produs");
              panou.querySelector("[data-produs-nume]").textContent = b.getAttribute("data-nume") + (b.getAttribute("data-cod") ? " (" + b.getAttribute("data-cod") + ")" : "");
              var um = b.getAttribute("data-um") || "";
              panou.querySelector("[data-liber]").textContent = cant(b.getAttribute("data-liber")) + (um ? " " + um : "");
              panou.querySelector("[data-um]").textContent = um ? "(" + um + ")" : "";
              f.querySelector('input[name="cantitate"]').value = "";
              panou.hidden = false;
              panou.scrollIntoView({ behavior: "smooth", block: "start" });
              var c = f.querySelector(".cauta-client");
              if (c) c.focus();
              return;
            }
            if (e.target.closest && e.target.closest("[data-renunta]")) panou.hidden = true;
          });
        })();
      </script>`;
  }

  const cap = ["Produs", "Categorie", "În stoc", "Disponibil", "Stare", "Promis pe comenzi", "Rezervat", "Urmează să intre", "Sosire", "Categorie nomenclator"];
  const randuri = vizibile.map((r) => celule(r, ctx, inapoi, poateRez));

  const body = `
    ${opt && opt.subtabs ? opt.subtabs : ""}
    <h1 style="margin:6px 0 2px">Stoc la zi</h1>
    <p style="margin:0 0 8px;color:var(--text-muted);font-size:13px;max-width:980px">
      Ce e acum în CT-Park, pe produse: cât e pe stoc, cât e deja promis pe comenzile clienților, cât e rezervat de agenți
      și cât e liber. Lângă fiecare produs scrie și ce urmează să intre: comenzile la furnizori (cu data cerută) și
      producția, cu clientul pentru care se face. ${poateRez ? "Butonul „Rezervă” ține marfa 3 zile pe numele unui client." : ""}
    </p>
    ${cutieMesaj(q)}
    <form method="get" action="${STOC}" class="toolbar" style="flex-wrap:wrap;align-items:center">
      <span style="font-size:13px"><strong>Pe produse</strong> · <a href="${STOC}?vedere=paleti${cauta ? "&q=" + encodeURIComponent(cauta) : ""}">Pe paleți</a></span>
      <input type="search" name="q" value="${esc(cauta)}" placeholder="${vedeTot ? "caută produs, cod, lot, client, furnizor…" : "caută produs, cod, lot, client…"}" style="flex:1 1 240px;min-width:0;max-width:420px">
      ${tip ? `<input type="hidden" name="tip" value="${esc(tip)}">` : ""}
      ${arata ? `<input type="hidden" name="arata" value="${esc(arata)}">` : ""}
      <button class="btn" type="submit">Caută</button>
      ${cauta || tip || arata ? `<a class="btn secondary" href="${STOC}">Vezi tot</a>` : ""}
      <a class="btn secondary" href="${REZERVARI}">Rezervări</a>
      ${
        user && user.rol === "admin"
          ? `<a class="btn secondary" href="${STOC}/export.xlsx${cauta ? "?q=" + encodeURIComponent(cauta) : ""}"
                title="${cauta ? "Doar paleții găsiți la căutare" : "Tot stocul"}, pe paleți, cu furnizor, preț și valoare">Export Excel</a>`
          : ""
      }
      ${
        poateIntra
          ? `<a class="btn secondary" href="/stocuri/ct-park/intrare">+ Intrare marfă</a>`
          : `<button type="button" class="btn secondary" disabled title="Intrarea de marfă o face depozitul" style="opacity:.45;cursor:not-allowed">+ Intrare marfă</button>`
      }
    </form>
    ${chipsTip}
    ${chipsArata}
    ${cards}
    ${panou}
    ${
      vizibile.length
        ? `<div class="tabel-scroll">${table(cap, randuri, { filtre: "stoc-produse" })}</div>`
        : `<p style="margin-top:18px">${cauta || tip || arata ? "Nimic nu se potrivește cu ce ai ales." : "Depozitul e gol și nu urmează să intre nimic."}</p>`
    }
    ${scriptClienti}
  `;
  send(ctx.res, 200, layout({ user, title: "Stoc la zi · CT-Park", active: "/stocuri/ct-park", body }));
}

function subtabs(activ, user) {
  return require("./ct-park").subtabs(activ, user);
}

async function paginaRezervari(ctx) {
  const user = ctx.user;
  const q = ctx.query || {};
  const filtru = RA.FILTRE[String(q.stare || "")] ? String(q.stare) : "active";
  const { randuri, cate } = await RA.lista(filtru);
  const inapoi = `${REZERVARI}${filtru === "active" ? "" : "?stare=" + filtru}`;
  const ETICHETE = { active: "Active", nefructificate: "Nefructificate", fructificate: "Fructificate", toate: "Toate" };
  const taburi = `<div class="subnav" style="margin:8px 0">${Object.keys(ETICHETE)
    .map(
      (k) =>
        `<a href="${REZERVARI}${k === "active" ? "" : "?stare=" + k}" class="subnav-link${filtru === k ? " activ" : ""}">${ETICHETE[k]} <span style="color:var(--text-muted)">(${cate[k]})</span></a>`
    )
    .join("")}</div>`;

  const BADGE = { activa: "albastru", fructificata: "verde", expirata: "gri", eliberata: "galben", anulata: "rosu" };
  const rand = (r) => {
    const um = r.um ? " " + esc(r.um) : "";
    let motiv = "—";
    if (r.stare === "eliberata") motiv = `${esc(r.motiv || "")}${r.inchisa_de ? mic("de " + esc(r.inchisa_de)) : ""}`;
    else if (r.stare === "expirata") motiv = "3 zile fără comandă";
    else if (r.stare === "anulata") motiv = esc(r.motiv || "");
    return [
      `<strong>${esc(r.produs || "#" + r.produs_id)}</strong>${r.cod ? mic(esc(r.cod)) : ""}`,
      esc(r.client || "#" + r.partener_id),
      esc(r.agent || "—"),
      `${cant(r.cantitate)}${um}`,
      esc(RA.dataOra(r.creata_la)),
      esc(RA.dataOra(r.stare === "activa" ? r.expira_la : r.inchisa_la || r.expira_la)),
      `<span class="badge ${BADGE[r.stare] || "gri"}">${esc(RA.STARI[r.stare] || r.stare)}</span>`,
      motiv,
      r.comanda_id ? linkDoc(user, `/comenzi/${r.comanda_id}`, r.comanda_numar || "#" + r.comanda_id) : "—",
      r.stare === "activa" && RA.poateElibera(user, r) ? formElibereaza(r, inapoi) : "",
    ];
  };
  const cap = ["Produs", "Client", "Agent", "Cantitate", "Rezervată la", filtru === "active" ? "Expiră la" : "Expiră / închisă la", "Stare", "Motiv", "Comanda", "<span></span>"];
  const body = `
    ${subtabs(REZERVARI, user)}
    <h1 style="margin:6px 0 2px">Rezervări de stoc</h1>
    <p style="margin:0 0 6px;color:var(--text-muted);font-size:13px;max-width:980px">
      Rezervările făcute de agenți din <a href="${STOC}">Stoc la zi</a>. O rezervare ține 3 zile. Devine
      <strong>fructificată</strong> când clientul pune comanda cu produsul, <strong>expiră</strong> singură după 3 zile fără
      comandă, iar înainte de termen o poate elibera agentul ei sau un administrator, cu motiv.
      <strong>Nefructificate</strong> = expirate și eliberate, cu motivul.
    </p>
    ${cutieMesaj(q)}
    ${taburi}
    <div class="tabel-scroll">${table(cap, randuri.map(rand), { filtre: "rezervari-agenti" })}</div>
  `;
  send(ctx.res, 200, layout({ user, title: "Rezervări de stoc · CT-Park", active: "/stocuri/ct-park", body }));
}

function register(router) {
  router.post(`${STOC}/rezerva`, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body || {};
    const inapoi = inapoiSigur(b.inapoi);
    const r = await RA.rezerva(b, ctx.user);
    redirect(ctx.res, cuMesaj(inapoi, r.ok ? "ok" : "eroare", r.ok ? r.mesaj : r.eroare));
  });

  router.get(REZERVARI, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    await paginaRezervari(ctx);
  });

  router.post(`${REZERVARI}/:id/elibereaza`, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body || {};
    const inapoi = inapoiSigur(b.inapoi);
    const r = await RA.elibereaza(ctx.params.id, b.motiv, ctx.user);
    redirect(ctx.res, cuMesaj(inapoi, r.ok ? "ok" : "eroare", r.ok ? r.mesaj : r.eroare));
  });
}

module.exports = { register, pagina, paginaRezervari, inapoiSigur, cuMesaj, TIPURI, ARATA };
