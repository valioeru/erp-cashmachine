"use strict";
// Comenzi către furnizor — hârtia care pleacă afară, nu cererea internă.
//
// CE ERA ÎNAINTE și de ce nu ajungea: `aprovizionari` e ce cere depozitul
// („îmi lipsesc 300 kg de granulă"). Un produs, fără preț, fără furnizor, fără
// document. Bun ca semnal, inutil ca și comandă: nu poți trimite nimănui o
// listă de lipsuri și nu poți ști peste trei luni cât ai plătit și cine a
// întârziat. Procurement ține OFERTELE (cine cât cere). Între ofertă și
// recepție lipsea tocmai comanda.
//
// CE FACE pagina asta, în cuvintele lui Vali: „înregistrare și trimitere
// comandă furnizor ptr materii prime … se trimite de pe contul
// comercial@cashmachine.ro … dacă nu există să îl pot adăuga printr-un click
// … rămân comenzile în curs sau livrate cu data solicitată și data recepție …
// istoric preț … filtre pe toate astea plus suma totală comandată".
//
// DOUĂ DECIZII care se văd peste tot în fișier:
//
//   • ISTORICUL DE PREȚ NU ARE TABELĂ PROPRIE. Istoricul sunt chiar liniile
//     comenzilor vechi. O a doua tabelă ar începe să mintă din prima zi în
//     care cineva corectează o linie și uită de ea.
//
//   • LINIA POATE SĂ N-AIBĂ PRODUS DIN NOMENCLATOR. Materia primă pe care n-ai
//     cumpărat-o încă nu are cum să fie în nomenclator; dacă aș cere obligatoriu
//     un produs, omul ar inventa unul ca să treacă de formular, iar nomenclatorul
//     s-ar umple de fantome. Denumirea scrisă de mână e de ajuns; produsul, când
//     există, leagă comanda de istoricul de preț și de stoc.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const mail = require("../lib/mail");
const L = require("../lib/comenzi-furnizor-logica");

// Adresa de pe care pleacă, cerută explicit. Rămâne schimbabilă din formular
// pentru cine are și alte căsuțe — lib/mail verifică singur dacă are voie.
const EXPEDITOR = "comercial@cashmachine.ro";

const MONEDE = ["RON", "EUR", "USD"];
const UNITATI = ["kg", "buc", "ml", "mp", "tonă", "rolă", "palet", "set", "litru", "oră"];
const CURS_IMPLICIT = 5.25;

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const azi = () => new Date().toISOString().slice(0, 10);
const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const text = (v) => String(v === null || v === undefined ? "" : v).trim();
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Numărul cu zecimale, scris ca în România. Nu `money()`: acolo scrie „lei",
// iar jumătate din comenzile astea sunt în euro.
function sumaCu(v, moneda) {
  return nr(v).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (moneda || "RON");
}

async function curs() {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'ach_curs_eur'").get();
    const v = Number(String((r && r.valoare) || "").replace(",", "."));
    return v > 0 ? v : CURS_IMPLICIT;
  } catch (e) {
    return CURS_IMPLICIT;
  }
}

function inLei(v, moneda, c) {
  const p = nr(v);
  if (moneda === "RON") return p;
  if (moneda === "USD") return p * c * 0.92;
  return p * c;
}

// Cine are voie să înregistreze și să trimită comenzi. Pagina stă sub zona
// /procurement, deci accesul e deja filtrat de lib/auth; aici se verifică doar
// ce e ireversibil — trimiterea unui email și anularea unei comenzi.
function poateTrimite(user) {
  return Boolean(user && (user.rol === "admin" || user.rol === "depozit" || user.rol === "financiar"));
}

const badgeStatus = (s) => {
  const culoare = { ciorna: "", trimisa: "albastru", confirmata: "albastru", partial: "galben", primita: "verde", anulata: "rosu" }[s] || "";
  return `<span class="badge ${culoare}">${esc(L.STATUS_ETICHETA[s] || s)}</span>`;
};

async function liniile(comandaId) {
  return db
    .prepare(
      `SELECT l.*, p.cod AS produs_cod, p.denumire AS produs_denumire
         FROM comenzi_furnizor_linii l
         LEFT JOIN produse p ON p.id = l.produs_id
        WHERE l.comanda_id = ? ORDER BY l.id`
    )
    .all(comandaId);
}

// Ultimul preț plătit pe fiecare produs, din liniile comenzilor de dinainte.
// DISTINCT ON e al Postgresului și face exact ce trebuie: un rând pe produs,
// cel mai recent. Comenzile anulate nu intră — un preț dintr-o comandă anulată
// n-a fost niciodată plătit.
async function ultimelePreturi() {
  try {
    const r = await db
      .prepare(
        `SELECT DISTINCT ON (l.produs_id)
                l.produs_id, l.pret_unitar, l.um, c.moneda, c.data, COALESCE(p.nume, '') AS furnizor
           FROM comenzi_furnizor_linii l
           JOIN comenzi_furnizor c ON c.id = l.comanda_id
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
          WHERE l.produs_id IS NOT NULL AND l.pret_unitar IS NOT NULL AND c.status <> 'anulata'
          ORDER BY l.produs_id, c.data DESC, c.id DESC`
      )
      .all();
    const m = new Map();
    for (const x of r) m.set(Number(x.produs_id), x);
    return m;
  } catch (e) {
    return new Map();
  }
}

// Istoricul de preț al unui produs: toate liniile de pe comenzile vechi.
async function istoricProdus(produsId, exclude) {
  if (!produsId) return [];
  return db
    .prepare(
      `SELECT l.pret_unitar, l.cantitate, l.um, c.id AS comanda_id, c.numar, c.data, c.moneda, c.status,
              COALESCE(p.nume, '—') AS furnizor
         FROM comenzi_furnizor_linii l
         JOIN comenzi_furnizor c ON c.id = l.comanda_id
         LEFT JOIN parteneri p ON p.id = c.furnizor_id
        WHERE l.produs_id = ? AND c.status <> 'anulata' AND c.id <> ?
        ORDER BY c.data DESC, c.id DESC LIMIT 12`
    )
    .all(produsId, exclude || 0);
}

// ---------------------------------------------------------------------------
// Alegerea produsului pe linie: un singur <datalist> pentru tot formularul.
//
// De ce nu lista derulantă scrisă de mână, ca la comenzile de client: aia a
// trebuit reparată o dată pentru că `position:absolute` o tăia la câțiva pixeli
// în celula de tabel. <datalist> e al browserului, nu se taie niciodată, caută
// singur în timp ce scrii și — important aici — lasă omul să scrie o denumire
// care nu există în nomenclator, ceea ce la materie primă e cazul obișnuit.
function datalistProduse(produse, preturi) {
  const date = produse.map((p) => {
    const u = preturi.get(Number(p.id));
    return [
      p.id,
      (p.cod ? p.cod + " · " : "") + p.denumire,
      p.unitate_masura || "buc",
      p.categorie || "",
      u ? nr(u.pret_unitar) : null,
      u ? u.moneda : "",
      u ? String(u.data).slice(0, 10) : "",
      u ? u.furnizor : "",
    ];
  });
  const categorii = [...new Set(produse.map((p) => text(p.categorie)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ro"));
  return `
    <datalist id="cf-produse"></datalist>
    <script>
    var CF_PRODUSE = ${JSON.stringify(date).replace(/</g, "\\u003c")};
    var CF_CATEGORII = ${JSON.stringify(categorii).replace(/</g, "\\u003c")};
    var CF_DUPA_ETICHETA = {};
    CF_PRODUSE.forEach(function (p) { CF_DUPA_ETICHETA[p[1].toLowerCase()] = p; });

    // Lista se reconstruiește doar când se schimbă categoria. Cu toate
    // produsele deodată ar fi mii de noduri în pagină la fiecare tastă.
    function cfUmpleLista(categorie) {
      var dl = document.getElementById("cf-produse");
      var html = "";
      var puse = 0;
      for (var i = 0; i < CF_PRODUSE.length && puse < 1200; i++) {
        var p = CF_PRODUSE[i];
        if (categorie && p[3] !== categorie) continue;
        html += '<option value="' + String(p[1]).replace(/"/g, "&quot;") + '">';
        puse++;
      }
      dl.innerHTML = html;
    }

    // Ce se întâmplă când omul a ales un produs: se completează unitatea și,
    // dacă n-a scris deja un preț, ultimul preț plătit — ca propunere, nu ca
    // adevăr. Scrie dedesubt de când e și de la cine, ca să se vadă dacă mai
    // are vreo legătură cu realitatea.
    function cfLeagaRand(rand) {
      var inp = rand.querySelector(".cf-produs");
      if (!inp || inp.dataset.legat) return;
      inp.dataset.legat = "1";
      inp.addEventListener("input", function () {
        var p = CF_DUPA_ETICHETA[String(inp.value || "").toLowerCase()];
        var ascuns = rand.querySelector(".cf-produs-id");
        var um = rand.querySelector(".cf-um");
        var pret = rand.querySelector(".cf-pret");
        var nota = rand.querySelector(".cf-nota");
        if (!p) { if (ascuns) ascuns.value = ""; if (nota) nota.textContent = ""; return; }
        if (ascuns) ascuns.value = p[0];
        if (um && !um.value) um.value = p[2];
        if (p[4] !== null && p[4] !== undefined) {
          if (pret && !pret.value) pret.value = p[4];
          if (nota) nota.textContent = "ultima dată " + p[4] + " " + p[5] + " la " + p[6] + (p[7] ? " de la " + p[7] : "");
        } else if (nota) {
          nota.textContent = "n-a mai fost comandat prin ERP";
        }
      });
    }

    function cfRandNou() {
      var corp = document.getElementById("cf-linii");
      var sablon = corp.querySelector("tr");
      var rand = sablon.cloneNode(true);
      rand.querySelectorAll("input").forEach(function (i) { i.value = ""; delete i.dataset.legat; });
      var n = rand.querySelector(".cf-nota"); if (n) n.textContent = "";
      corp.appendChild(rand);
      cfLeagaRand(rand);
    }

    document.addEventListener("DOMContentLoaded", function () {
      var sel = document.getElementById("cf-categorie");
      if (sel) {
        CF_CATEGORII.forEach(function (c) {
          var o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o);
        });
        sel.addEventListener("change", function () { cfUmpleLista(sel.value); });
      }
      cfUmpleLista("");
      document.querySelectorAll("#cf-linii tr").forEach(cfLeagaRand);
      var b = document.getElementById("cf-adauga");
      if (b) b.addEventListener("click", cfRandNou);
    });
    </script>`;
}

function register(router) {
  // ---- lista, cu filtre pe tot ce s-a cerut ------------------------------
  router.get("/procurement/comenzi", async (ctx) => {
    const q = ctx.query || {};
    const cauta = text(q.q);
    const furnizorId = parseInt(q.furnizor, 10) || null;
    const statusAles = text(q.status);
    const deLa = text(q.de_la).slice(0, 10);
    const panaLa = text(q.pana_la).slice(0, 10);
    const solDeLa = text(q.sol_de_la).slice(0, 10);
    const recDeLa = text(q.rec_de_la).slice(0, 10);
    const c = await curs();

    const unde = [];
    const args = [];
    if (furnizorId) {
      unde.push("c.furnizor_id = ?");
      args.push(furnizorId);
    }
    if (statusAles === "deschise") unde.push("c.status IN ('ciorna','trimisa','confirmata','partial')");
    else if (statusAles === "primite") unde.push("c.status IN ('primita','partial')");
    else if (statusAles && L.STATUS_ETICHETA[statusAles]) {
      unde.push("c.status = ?");
      args.push(statusAles);
    }
    if (deLa) {
      unde.push("c.data >= ?");
      args.push(deLa);
    }
    if (panaLa) {
      unde.push("c.data <= ?");
      args.push(panaLa);
    }
    if (solDeLa) {
      unde.push("c.data_solicitata >= ?");
      args.push(solDeLa);
    }
    if (recDeLa) {
      unde.push("c.data_receptie >= ?");
      args.push(recDeLa);
    }
    // Căutarea prinde și numărul comenzii, și numele furnizorului, și ce scrie
    // pe linii — omul își amintește „aia cu granula", nu numărul ei.
    if (cauta) {
      unde.push(
        `(c.numar ILIKE ? OR COALESCE(p.nume,'') ILIKE ? OR EXISTS (
            SELECT 1 FROM comenzi_furnizor_linii l WHERE l.comanda_id = c.id AND l.denumire ILIKE ?))`
      );
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }

    const comenzi = await db
      .prepare(
        `SELECT c.*, COALESCE(p.nume, '—') AS furnizor, u.nume AS creata_nume,
                (SELECT COUNT(*) FROM comenzi_furnizor_linii l WHERE l.comanda_id = c.id) AS nr_linii,
                (SELECT COALESCE(SUM(l.cantitate * l.pret_unitar), 0) FROM comenzi_furnizor_linii l
                  WHERE l.comanda_id = c.id AND l.pret_unitar IS NOT NULL) AS total,
                (SELECT COUNT(*) FROM comenzi_furnizor_linii l
                  WHERE l.comanda_id = c.id AND l.pret_unitar IS NULL) AS fara_pret
           FROM comenzi_furnizor c
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
           LEFT JOIN utilizatori u ON u.id = c.creata_de
          ${unde.length ? "WHERE " + unde.join(" AND ") : ""}
          ORDER BY c.data DESC, c.id DESC
          LIMIT 500`
      )
      .all(...args);

    const furnizori = await db
      .prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 3000")
      .all();

    const peMoneda = L.totaluriPeMoneda(comenzi.filter((x) => x.status !== "anulata"));
    const totalLei = [...peMoneda.entries()].reduce((s, [m, v]) => s + inLei(v, m, c), 0);
    const deschise = comenzi.filter((x) => L.DESCHISE.includes(x.status));
    const intarziate = deschise.filter((x) => x.data_solicitata && String(x.data_solicitata).slice(0, 10) < azi());

    const randuri = comenzi.map((x) => {
      const intr = L.intarziere(x.data_solicitata, x.data_receptie);
      return [
        `<a href="/procurement/comenzi/${x.id}"><strong>${esc(x.numar || "#" + x.id)}</strong></a>`,
        esc(String(x.data || "").slice(0, 10)),
        esc(x.furnizor),
        badgeStatus(x.status),
        String(x.nr_linii),
        `<strong>${esc(sumaCu(x.total, x.moneda))}</strong>${x.fara_pret ? `<br><span style="font-size:12px;color:var(--text-muted)">+${x.fara_pret} fără preț</span>` : ""}`,
        x.data_solicitata
          ? esc(String(x.data_solicitata).slice(0, 10)) +
            (!x.data_receptie && String(x.data_solicitata).slice(0, 10) < azi() && L.DESCHISE.includes(x.status)
              ? ' <span class="badge rosu">depășit</span>'
              : "")
          : '<span style="color:var(--text-muted)">—</span>',
        x.data_receptie
          ? esc(String(x.data_receptie).slice(0, 10)) +
            (intr === null ? "" : ` <span style="font-size:12px;color:var(--text-muted)">${intr > 0 ? "+" + intr + " zile" : intr === 0 ? "la timp" : intr + " zile"}</span>`)
          : '<span style="color:var(--text-muted)">—</span>',
      ];
    });

    const body = `
      <div class="toolbar">
        <a href="/procurement/comenzi/noua" class="btn">+ Comandă nouă</a>
        <a href="/procurement/comenzi/preturi" class="btn secondary">Istoric prețuri</a>
        <a href="/procurement" class="btn secondary">Oferte de la furnizori</a>
      </div>

      <form class="filtre" method="get" action="/procurement/comenzi">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="număr, furnizor sau produs" style="min-width:240px">
        <select name="furnizor">
          <option value="">toți furnizorii</option>
          ${furnizori.map((f) => `<option value="${f.id}"${furnizorId === f.id ? " selected" : ""}>${esc(f.nume)}</option>`).join("")}
        </select>
        <select name="status">
          <option value="">toate stările</option>
          <option value="deschise"${statusAles === "deschise" ? " selected" : ""}>în curs</option>
          <option value="primite"${statusAles === "primite" ? " selected" : ""}>primite (și parțial)</option>
          ${Object.keys(L.STATUS_ETICHETA).map((s) => `<option value="${s}"${statusAles === s ? " selected" : ""}>${esc(L.STATUS_ETICHETA[s])}</option>`).join("")}
        </select>
        <label style="font-size:13px">data comenzii <input type="date" name="de_la" value="${esc(deLa)}"> – <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
        <label style="font-size:13px">solicitată după <input type="date" name="sol_de_la" value="${esc(solDeLa)}"></label>
        <label style="font-size:13px">recepție după <input type="date" name="rec_de_la" value="${esc(recDeLa)}"></label>
        <button class="btn small" type="submit">Filtrează</button>
        <a class="btn small secondary" href="/procurement/comenzi">Golește</a>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Comenzi în filtru</div><div class="value">${comenzi.length}</div></div>
        <div class="card"><div class="label">În curs</div><div class="value">${deschise.length}</div></div>
        <div class="card"><div class="label">Cu termen depășit</div><div class="value">${intarziate.length}</div></div>
        <div class="card"><div class="label">Total comandat</div><div class="value">${esc(
          [...peMoneda.entries()].map(([m, v]) => sumaCu(v, m)).join(" + ") || "0,00 RON"
        )}</div>${peMoneda.size > 1 ? `<div class="label">≈ ${esc(money(totalLei))}</div>` : ""}</div>
      </div>

      ${
        comenzi.length
          ? table(
              ["Număr", "Data", "Furnizor", "Stare", "Poziții", "Valoare", "Solicitată", "Recepție"],
              randuri
            )
          : `<p>Nicio comandă în filtrul ales. <a href="/procurement/comenzi/noua">Înregistrează prima</a>.</p>`
      }

      ${
        peMoneda.size > 1
          ? `<p style="font-size:12px;color:var(--text-muted)">Totalul în lei e doar pentru comparație, la cursul de ${esc(String(c).replace(".", ","))} lei/euro din Procurement. Nu e o sumă contabilă.</p>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comenzi către furnizori", active: "/procurement/comenzi", body }));
  });

  // ---- istoricul de preț, pe produs --------------------------------------
  router.get("/procurement/comenzi/preturi", async (ctx) => {
    const cauta = text((ctx.query || {}).q);
    const unde = ["c.status <> 'anulata'", "l.pret_unitar IS NOT NULL"];
    const args = [];
    if (cauta) {
      unde.push("(l.denumire ILIKE ? OR COALESCE(p.nume,'') ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`);
    }
    const linii = await db
      .prepare(
        `SELECT l.denumire, l.produs_id, l.pret_unitar, l.cantitate, l.um,
                c.id AS comanda_id, c.numar, c.data, c.moneda, COALESCE(p.nume,'—') AS furnizor
           FROM comenzi_furnizor_linii l
           JOIN comenzi_furnizor c ON c.id = l.comanda_id
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
          WHERE ${unde.join(" AND ")}
          ORDER BY LOWER(l.denumire), c.data DESC, c.id DESC
          LIMIT 1500`
      )
      .all(...args);

    // Gruparea pe produs: pe produs_id când există, altfel pe denumirea scrisă.
    // Două linii scrise diferit rămân două rânduri — și e bine așa: pretinsa
    // potrivire pe text ar lipi „granulă PP" de „granulă PP reciclat".
    const grupe = new Map();
    for (const l of linii) {
      const cheie = l.produs_id ? "p" + l.produs_id : "t" + text(l.denumire).toLowerCase();
      if (!grupe.has(cheie)) grupe.set(cheie, []);
      grupe.get(cheie).push(l);
    }

    const blocuri = [...grupe.values()]
      .filter((g) => g.length)
      .map((g) => {
        const ultima = g[0];
        const variatie = (() => {
          const aceeasiMoneda = g.filter((x) => x.moneda === ultima.moneda);
          if (aceeasiMoneda.length < 2) return "";
          const prima = aceeasiMoneda[aceeasiMoneda.length - 1];
          const d = nr(ultima.pret_unitar) - nr(prima.pret_unitar);
          if (!nr(prima.pret_unitar)) return "";
          const pct = (d / nr(prima.pret_unitar)) * 100;
          const semn = d > 0 ? "+" : "";
          const culoare = d > 0 ? "var(--rosu, #b23)" : d < 0 ? "var(--verde, #171)" : "var(--text-muted)";
          return `<span style="color:${culoare}">${semn}${pct.toFixed(1).replace(".", ",")}% față de ${esc(String(prima.data).slice(0, 10))}</span>`;
        })();
        return `
          <h3 style="margin:22px 0 6px">${esc(ultima.denumire)} <span style="font-weight:400;font-size:13px;color:var(--text-muted)">· ${g.length} ${g.length === 1 ? "comandă" : "comenzi"} ${variatie}</span></h3>
          ${table(
            ["Data", "Comandă", "Furnizor", "Preț unitar", "Cantitate"],
            g.slice(0, 10).map((x) => [
              esc(String(x.data).slice(0, 10)),
              `<a href="/procurement/comenzi/${x.comanda_id}">${esc(x.numar || "#" + x.comanda_id)}</a>`,
              esc(x.furnizor),
              `<strong>${esc(nr(x.pret_unitar).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }))} ${esc(x.moneda)}</strong>${x.um ? "/" + esc(x.um) : ""}`,
              esc(nr(x.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })) + (x.um ? " " + esc(x.um) : ""),
            ])
          )}`;
      });

    const body = `
      <div class="toolbar"><a href="/procurement/comenzi" class="btn secondary">← Comenzi</a></div>
      <form class="filtre" method="get" action="/procurement/comenzi/preturi">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="produs sau furnizor" style="min-width:280px">
        <button class="btn small" type="submit">Caută</button>
      </form>
      <p style="font-size:13px;color:var(--text-muted)">
        Prețurile de aici sunt chiar liniile comenzilor trimise, nu o listă ținută separat. Comenzile anulate nu apar.
      </p>
      ${blocuri.length ? blocuri.join("") : "<p>Încă nu există comenzi cu preț.</p>"}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Istoric prețuri de achiziție", active: "/procurement/comenzi", body }));
  });

  // ---- formular de comandă nouă ------------------------------------------
  router.get("/procurement/comenzi/noua", async (ctx) => {
    const eroare = text((ctx.query || {}).eroare);
    const furnizorAles = parseInt((ctx.query || {}).furnizor, 10) || null;
    const furnizori = await db
      .prepare("SELECT id, nume, email FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 3000")
      .all();
    const produse = await db
      .prepare("SELECT id, cod, denumire, unitate_masura, categorie FROM produse WHERE COALESCE(activ,1) = 1 ORDER BY denumire LIMIT 6000")
      .all();
    const preturi = await ultimelePreturi();

    const randGol = `
      <tr>
        <td>
          <input class="cf-produs" list="cf-produse" name="denumire[]" placeholder="scrie sau alege din nomenclator" style="width:100%" autocomplete="off">
          <input type="hidden" class="cf-produs-id" name="produs_id[]" value="">
          <div class="cf-nota" style="font-size:12px;color:var(--text-muted);min-height:15px"></div>
        </td>
        <td><input type="number" step="0.001" class="cf-cant" name="cantitate[]" style="width:110px"></td>
        <td><input class="cf-um" name="um[]" list="cf-unitati" style="width:90px"></td>
        <td><input type="number" step="0.0001" class="cf-pret" name="pret_unitar[]" style="width:120px" placeholder="opțional"></td>
      </tr>`;

    const body = `
      ${eroare ? `<div class="flash eroare">${esc({ furnizor: "Alege un furnizor sau adaugă-l cu butonul de lângă.", linii: "O comandă fără nicio poziție cu denumire și cantitate n-are ce trimite.", cantitate: "O poziție are denumire dar n-are cantitate. Scrie cantitatea sau șterge rândul." }[eroare] || "Comanda nu s-a putut salva.")}</div>` : ""}

      <form class="form" method="post" action="/procurement/comenzi" style="max-width:980px">
        <h2>Către cine</h2>
        <div style="display:grid;grid-template-columns:3fr auto;gap:12px;align-items:end">
          <label class="field"><span>Furnizor</span>
            <select name="furnizor_id" required>
              <option value="">— alege —</option>
              ${furnizori.map((f) => `<option value="${f.id}"${furnizorAles === f.id ? " selected" : ""}>${esc(f.nume)}${f.email ? " · " + esc(f.email) : ""}</option>`).join("")}
            </select>
          </label>
          <button type="button" class="btn secondary" onclick="document.getElementById('cf-furnizor-nou').style.display='block';this.style.display='none'">+ Furnizor nou</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <label class="field"><span>Data comenzii</span><input type="date" name="data" value="${azi()}" required></label>
          <label class="field"><span>Data solicitată de livrare</span><input type="date" name="data_solicitata"></label>
          <label class="field"><span>Moneda</span><select name="moneda">${MONEDE.map((m) => `<option value="${m}">${m}</option>`).join("")}</select></label>
        </div>

        <h2>Ce comandăm</h2>
        <label class="field" style="max-width:380px"><span>Filtrează produsele pe categorie</span>
          <select id="cf-categorie"><option value="">toate categoriile</option></select>
        </label>
        <table class="tabel">
          <thead><tr><th style="width:52%">Produs / denumire</th><th>Cantitate</th><th>UM</th><th>Preț unitar</th></tr></thead>
          <tbody id="cf-linii">${randGol}${randGol}${randGol}</tbody>
        </table>
        <p><button type="button" class="btn small secondary" id="cf-adauga">+ Încă o poziție</button></p>

        <label class="field"><span>Observații pentru furnizor (intră în email)</span><textarea name="observatii" rows="2" placeholder="ex. livrare la Afumați, în intervalul 8–16"></textarea></label>

        <div class="form-actions">
          <button class="btn" type="submit" name="actiune" value="salveaza">Salvează comanda</button>
          <a href="/procurement/comenzi" class="btn secondary">Renunță</a>
        </div>
        <p style="font-size:12px;color:var(--text-muted)">
          Se salvează ca ciornă. Emailul către furnizor se trimite din pagina comenzii, după ce îl vezi scris.
        </p>
      </form>

      <!-- Furnizorul nou se adaugă din aceeași pagină, dar cu formularul lui:
           altfel un câmp gol de la furnizor ar bloca salvarea comenzii, sau
           invers. -->
      <form class="form" id="cf-furnizor-nou" method="post" action="/procurement/furnizor" style="display:none;max-width:980px;margin-top:28px;border-top:1px solid var(--border);padding-top:18px">
        <h2>Furnizor nou</h2>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">
          <label class="field"><span>Denumire</span><input name="nume" required placeholder="ex. Teraplast SA"></label>
          <label class="field"><span>CUI</span><input name="cui" placeholder="RO12345678"></label>
          <label class="field"><span>Telefon</span><input name="telefon"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px">
          <label class="field"><span>Email firmă</span><input type="email" name="email" placeholder="office@furnizor.ro"></label>
          <label class="field"><span>Adresă</span><input name="adresa"></label>
        </div>
        <h3 style="margin-bottom:4px">Persoane de contact</h3>
        <p style="font-size:12px;color:var(--text-muted);margin-top:0">Câte vrei. Emailurile lor apar bifabile când trimiți comanda.</p>
        ${[0, 1, 2]
          .map(
            () => `<div style="display:grid;grid-template-columns:2fr 1fr 2fr 1fr;gap:10px;margin-bottom:8px">
              <input name="c_nume[]" placeholder="nume">
              <input name="c_functie[]" placeholder="funcție">
              <input type="email" name="c_email[]" placeholder="email">
              <input name="c_telefon[]" placeholder="telefon">
            </div>`
          )
          .join("")}
        <div class="form-actions">
          <button class="btn" type="submit">Adaugă furnizorul</button>
          <button type="button" class="btn secondary" onclick="this.closest('form').style.display='none'">Închide</button>
        </div>
      </form>

      <datalist id="cf-unitati">${UNITATI.map((u) => `<option value="${u}">`).join("")}</datalist>
      ${datalistProduse(produse, preturi)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă către furnizor", active: "/procurement/comenzi", body }));
  });

  // ---- salvarea comenzii --------------------------------------------------
  router.post("/procurement/comenzi", async (ctx) => {
    const b = ctx.body || {};
    const furnizorId = parseInt(b.furnizor_id, 10) || null;
    if (!furnizorId) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=furnizor");

    const denumiri = asArray(b["denumire[]"]);
    const produse = asArray(b["produs_id[]"]);
    const cantitati = asArray(b["cantitate[]"]);
    const unitati = asArray(b["um[]"]);
    const preturi = asArray(b["pret_unitar[]"]);

    const linii = [];
    for (let i = 0; i < denumiri.length; i++) {
      const den = text(denumiri[i]);
      const cantText = text(cantitati[i]).replace(",", ".");
      if (!den && !cantText) continue; // rând gol, lăsat de formular
      // O denumire fără cantitate e o greșeală de completare, nu o comandă de
      // zero bucăți. Se spune omului, nu se salvează tăcut.
      if (!den || !(Number(cantText) > 0)) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=cantitate");
      const pretText = text(preturi[i]).replace(",", ".");
      const pret = pretText === "" ? null : Number(pretText);
      linii.push({
        produs_id: parseInt(produse[i], 10) || null,
        denumire: den.slice(0, 300),
        cantitate: Number(cantText),
        um: text(unitati[i]).slice(0, 20) || null,
        pret_unitar: pret !== null && Number.isFinite(pret) && pret >= 0 ? pret : null,
      });
    }
    if (!linii.length) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=linii");

    const an = (text(b.data) || azi()).slice(0, 4);
    const ultim = await db
      .prepare("SELECT numar FROM comenzi_furnizor WHERE numar LIKE ? ORDER BY numar DESC LIMIT 1")
      .get("CF-" + an + "-%");
    const numar = L.numarUrmator(ultim && ultim.numar, an);

    const ins = await db
      .prepare(
        `INSERT INTO comenzi_furnizor (numar, furnizor_id, data, data_solicitata, status, moneda, observatii, creata_de)
         VALUES (?, ?, ?, ?, 'ciorna', ?, ?, ?) RETURNING id`
      )
      .run(
        numar,
        furnizorId,
        text(b.data).slice(0, 10) || azi(),
        text(b.data_solicitata).slice(0, 10) || null,
        MONEDE.includes(text(b.moneda)) ? text(b.moneda) : "RON",
        text(b.observatii) || null,
        ctx.user ? ctx.user.id : null
      );
    const id = ins.lastInsertRowid;

    for (const l of linii) {
      await db
        .prepare(
          `INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, um, pret_unitar)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, l.produs_id, l.denumire, l.cantitate, l.um, l.pret_unitar);
    }
    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });

  // ---- furnizor nou, din aceeași pagină ----------------------------------
  router.post("/procurement/furnizor", async (ctx) => {
    const b = ctx.body || {};
    const nume = text(b.nume);
    if (!nume) return redirect(ctx.res, "/procurement/comenzi/noua?eroare=furnizor");

    // Dacă firma există deja ca client, nu se face un al doilea rând: devine
    // „ambele". Două rânduri pe aceeași firmă înseamnă, peste trei luni,
    // jumătate din facturi pe unul și jumătate pe celălalt.
    const cui = text(b.cui).toUpperCase().replace(/[^0-9A-Z]/g, "");
    let existent = null;
    if (cui) {
      existent = await db
        .prepare("SELECT id, tip FROM parteneri WHERE UPPER(REGEXP_REPLACE(COALESCE(cui,''), '[^0-9A-Za-z]', '', 'g')) = ? LIMIT 1")
        .get(cui)
        .catch(() => null);
    }
    if (!existent) {
      existent = await db.prepare("SELECT id, tip FROM parteneri WHERE LOWER(nume) = LOWER(?) LIMIT 1").get(nume).catch(() => null);
    }

    let id;
    if (existent) {
      id = existent.id;
      const tipNou = existent.tip === "furnizor" || existent.tip === "ambele" ? existent.tip : "ambele";
      await db
        .prepare(
          `UPDATE parteneri SET tip = ?,
                  cui = COALESCE(NULLIF(cui,''), ?), email = COALESCE(NULLIF(email,''), ?),
                  telefon = COALESCE(NULLIF(telefon,''), ?), adresa = COALESCE(NULLIF(adresa,''), ?)
            WHERE id = ?`
        )
        .run(tipNou, text(b.cui) || null, text(b.email) || null, text(b.telefon) || null, text(b.adresa) || null, id);
    } else {
      const r = await db
        .prepare(
          `INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa, sursa, stare)
           VALUES ('furnizor', ?, ?, ?, ?, ?, 'comandă furnizor', 'furnizor') RETURNING id`
        )
        .run(nume, text(b.cui) || null, text(b.email) || null, text(b.telefon) || null, text(b.adresa) || null);
      id = r.lastInsertRowid;
    }

    const nume_ = asArray(b["c_nume[]"]);
    const fct = asArray(b["c_functie[]"]);
    const em = asArray(b["c_email[]"]);
    const tel = asArray(b["c_telefon[]"]);
    for (let i = 0; i < nume_.length; i++) {
      const n = text(nume_[i]);
      const e = text(em[i]);
      if (!n && !e) continue;
      await db
        .prepare(
          `INSERT INTO mk_contacte (partener_id, nume, functie, email, telefon, sursa, creat_de)
           VALUES (?, ?, ?, ?, ?, 'comandă furnizor', ?)`
        )
        .run(id, n || e, text(fct[i]) || null, e || null, text(tel[i]) || null, ctx.user ? ctx.user.id : null);
    }
    redirect(ctx.res, `/procurement/comenzi/noua?furnizor=${id}`);
  });

  // ---- o comandă: linii, istoric de preț, email, recepție ----------------
  router.get("/procurement/comenzi/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await db
      .prepare(
        `SELECT c.*, p.nume AS furnizor, p.email AS furnizor_email, p.cui AS furnizor_cui, u.nume AS creata_nume
           FROM comenzi_furnizor c
           LEFT JOIN parteneri p ON p.id = c.furnizor_id
           LEFT JOIN utilizatori u ON u.id = c.creata_de
          WHERE c.id = ?`
      )
      .get(id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/procurement/comenzi", body: "<p>Comanda asta nu există.</p>" }));

    const linii = await liniile(id);
    const t = L.totalComanda(linii);
    const contacte = await db
      .prepare("SELECT nume, functie, email FROM mk_contacte WHERE partener_id = ? AND COALESCE(activ,1) = 1 AND COALESCE(email,'') <> '' ORDER BY nume")
      .all(c.furnizor_id || 0)
      .catch(() => []);

    const eDeschisa = L.DESCHISE.includes(c.status);
    const intr = L.intarziere(c.data_solicitata, c.data_receptie);

    // Istoricul de preț, pe fiecare poziție care are produs în nomenclator.
    const istorii = new Map();
    for (const l of linii) {
      if (l.produs_id && !istorii.has(l.produs_id)) istorii.set(l.produs_id, await istoricProdus(l.produs_id, id));
    }

    const randuriLinii = linii.map((l) => {
      const v = L.valoareLinie(l);
      const ist = l.produs_id ? istorii.get(l.produs_id) || [] : [];
      const anterior = ist.find((x) => x.moneda === c.moneda && x.pret_unitar !== null);
      let fata = "";
      if (anterior && nr(anterior.pret_unitar) > 0 && l.pret_unitar !== null && l.pret_unitar !== undefined) {
        const d = ((nr(l.pret_unitar) - nr(anterior.pret_unitar)) / nr(anterior.pret_unitar)) * 100;
        const culoare = d > 0.05 ? "var(--rosu, #b23)" : d < -0.05 ? "var(--verde, #171)" : "var(--text-muted)";
        fata = `<span style="font-size:12px;color:${culoare}">${d > 0 ? "+" : ""}${d.toFixed(1).replace(".", ",")}% față de ${esc(String(anterior.data).slice(0, 10))} (${esc(anterior.furnizor)})</span>`;
      } else if (l.produs_id) {
        fata = `<span style="font-size:12px;color:var(--text-muted)">prima comandă prin ERP</span>`;
      }
      const primit = nr(l.cantitate_primita);
      return [
        `${esc(l.denumire)}${l.produs_cod ? `<br><span style="font-size:12px;color:var(--text-muted)">cod ${esc(l.produs_cod)}</span>` : ""}`,
        esc(nr(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })) + (l.um ? " " + esc(l.um) : ""),
        l.pret_unitar === null || l.pret_unitar === undefined
          ? '<span style="color:var(--text-muted)">de confirmat</span>'
          : `${esc(nr(l.pret_unitar).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }))} ${esc(c.moneda)}`,
        v === null ? '<span style="color:var(--text-muted)">—</span>' : `<strong>${esc(sumaCu(v, c.moneda))}</strong>`,
        primit > 0
          ? `${esc(primit.toLocaleString("ro-RO", { maximumFractionDigits: 3 }))}${primit + 0.0001 < nr(l.cantitate) ? ' <span class="badge galben">parțial</span>' : ' <span class="badge verde">complet</span>'}`
          : '<span style="color:var(--text-muted)">—</span>',
        fata,
      ];
    });

    const corp = L.corpEmail({
      comanda: c,
      linii,
      furnizor: c.furnizor,
      semnatura: `Cu stimă,\n${ctx.user ? ctx.user.nume : ""}\nCash Machine SRL\n${EXPEDITOR}`,
    });

    const destinatari = [];
    if (text(c.furnizor_email)) destinatari.push({ eticheta: c.furnizor + " (firmă)", email: text(c.furnizor_email) });
    for (const p of contacte) destinatari.push({ eticheta: p.nume + (p.functie ? ", " + p.functie : ""), email: text(p.email) });

    const body = `
      <div class="toolbar">
        <a href="/procurement/comenzi" class="btn secondary">← Toate comenzile</a>
        ${c.furnizor_id ? `<a href="/parteneri/${c.furnizor_id}" class="btn secondary">Fișa furnizorului</a>` : ""}
        <a href="/procurement/comenzi/preturi?q=${encodeURIComponent(linii[0] ? linii[0].denumire : "")}" class="btn secondary">Istoric prețuri</a>
      </div>

      <h1 style="margin-bottom:4px">${esc(c.numar || "#" + c.id)} ${badgeStatus(c.status)}</h1>
      <p style="color:var(--text-muted);margin-top:0">
        ${esc(c.furnizor || "fără furnizor")} · emisă ${esc(String(c.data || "").slice(0, 10))}${c.creata_nume ? " de " + esc(c.creata_nume) : ""}
        ${c.trimisa_la ? ` · trimisă ${esc(String(c.trimisa_la).slice(0, 16))} către ${esc(c.trimisa_catre || "")}` : ""}
      </p>

      <div class="cards">
        <div class="card"><div class="label">Valoare</div><div class="value">${esc(sumaCu(t.total, c.moneda))}</div>${t.faraPret ? `<div class="label">${t.faraPret} fără preț</div>` : ""}</div>
        <div class="card"><div class="label">Data solicitată</div><div class="value">${esc(String(c.data_solicitata || "—").slice(0, 10))}</div></div>
        <div class="card"><div class="label">Data recepției</div><div class="value">${esc(String(c.data_receptie || "—").slice(0, 10))}</div>${
          intr === null ? "" : `<div class="label">${intr > 0 ? "cu " + intr + " zile întârziere" : intr === 0 ? "la timp" : "cu " + -intr + " zile mai devreme"}</div>`
        }</div>
      </div>

      ${table(["Poziție", "Cantitate", "Preț unitar", "Valoare", "Primit", "Față de ultima"], randuriLinii)}
      ${c.observatii ? `<p><strong>Observații:</strong> ${esc(c.observatii)}</p>` : ""}

      ${
        eDeschisa && poateTrimite(ctx.user)
          ? `
      <h2 style="margin-top:28px">Trimite comanda</h2>
      ${
        destinatari.length
          ? `<form class="form" method="post" action="/procurement/comenzi/${c.id}/trimite" style="max-width:860px"
                   onsubmit="return confirm('Emailul pleacă acum către furnizor. Trimit?')">
          <div class="field"><span>Către</span>
            ${destinatari
              .map(
                (d, i) =>
                  `<label style="display:block;font-weight:400"><input type="checkbox" name="catre[]" value="${esc(d.email)}"${i === 0 ? " checked" : ""}> ${esc(d.eticheta)} — ${esc(d.email)}</label>`
              )
              .join("")}
          </div>
          <label class="field"><span>…și/sau alte adrese, despărțite cu virgulă</span><input name="catre_text" placeholder="nume@furnizor.ro"></label>
          <label class="field"><span>De pe adresa</span><input name="de_la" value="${esc(EXPEDITOR)}"></label>
          <label class="field"><span>Subiect</span><input name="subiect" value="Comandă ${esc(c.numar || "")} — Cash Machine SRL" required></label>
          <label class="field"><span>Mesaj</span><textarea name="corp" rows="16" style="font-family:monospace;font-size:13px">${esc(corp)}</textarea></label>
          <div class="form-actions"><button class="btn" type="submit">Trimite comanda pe email</button></div>
        </form>`
          : `<p>Furnizorul n-are nicio adresă de email, nici pe fișă nici pe persoanele de contact.
               <a href="/parteneri/${c.furnizor_id || ""}">Completeaz-o pe fișa lui</a> și revino.</p>`
      }`
          : ""
      }

      ${
        eDeschisa && poateTrimite(ctx.user)
          ? `
      <h2 style="margin-top:28px">Recepție</h2>
      <form class="form" method="post" action="/procurement/comenzi/${c.id}/receptie" style="max-width:860px">
        <p style="font-size:13px;color:var(--text-muted);margin-top:0">
          Scrie cât a intrat efectiv din fiecare poziție. Starea comenzii se calculează din cantități:
          „primită" doar când e acoperită fiecare linie.
        </p>
        <table class="tabel">
          <thead><tr><th>Poziție</th><th>Comandat</th><th>Primit până acum</th><th>Primit acum (total)</th></tr></thead>
          <tbody>
            ${linii
              .map(
                (l) => `<tr>
                  <td>${esc(l.denumire)}</td>
                  <td>${esc(nr(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 }))} ${esc(l.um || "")}</td>
                  <td>${esc(nr(l.cantitate_primita).toLocaleString("ro-RO", { maximumFractionDigits: 3 }))}</td>
                  <td>
                    <input type="hidden" name="linie_id[]" value="${l.id}">
                    <input type="number" step="0.001" name="primit[]" value="${esc(nr(l.cantitate_primita) || "")}" style="width:120px" placeholder="${esc(String(nr(l.cantitate)))}">
                  </td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-top:10px">
          <label class="field"><span>Data recepției</span><input type="date" name="data_receptie" value="${esc(String(c.data_receptie || azi()).slice(0, 10))}"></label>
          <label class="field"><span>&nbsp;</span>
            <label style="font-weight:400"><input type="checkbox" name="tot" value="1"> a intrat tot ce era comandat</label>
          </label>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Înregistrează recepția</button>
        </div>
      </form>

      <form method="post" action="/procurement/comenzi/${c.id}/anuleaza" style="margin-top:18px"
            onsubmit="return confirm('Comanda se marchează anulată. Rămâne în istoric, dar iese din totaluri. Continui?')">
        <button class="btn secondary" type="submit">Anulează comanda</button>
      </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă " + (c.numar || "#" + c.id), active: "/procurement/comenzi", body }));
  });

  // ---- trimiterea pe email ------------------------------------------------
  router.post("/procurement/comenzi/:id/trimite", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const b = ctx.body || {};
    const catre = asArray(b["catre[]"])
      .concat(text(b.catre_text).split(/[,;]/))
      .map((x) => text(x))
      .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (!catre.length) return redirect(ctx.res, `/procurement/comenzi/${id}?eroare=destinatar`);

    const c = await db.prepare("SELECT * FROM comenzi_furnizor WHERE id = ?").get(id);
    if (!c) return redirect(ctx.res, "/procurement/comenzi");

    let eroare = null;
    try {
      await mail.trimiteDeLa(ctx.user, {
        catre,
        subiect: text(b.subiect) || `Comandă ${c.numar || ""} — Cash Machine SRL`,
        corp: String(b.corp || ""),
        deLa: text(b.de_la) || EXPEDITOR,
      });
    } catch (e) {
      eroare = e.message;
    }

    if (!eroare) {
      await db
        .prepare(
          `UPDATE comenzi_furnizor SET status = CASE WHEN status = 'ciorna' THEN 'trimisa' ELSE status END,
                  trimisa_la = ?, trimisa_catre = ? WHERE id = ?`
        )
        .run(acum(), catre.join(", ").slice(0, 400), id);
      // Urma rămâne și pe fișa furnizorului: peste șase luni, când cineva
      // întreabă „i-am mai comandat?", răspunsul trebuie să fie pe fișă, nu
      // în memoria cuiva.
      if (c.furnizor_id) {
        await db
          .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'email', ?, ?, ?)")
          .run(c.furnizor_id, `Comandă ${c.numar || "#" + id} trimisă`, `Către ${catre.join(", ")}`, ctx.user ? ctx.user.id : null)
          .catch(() => {});
      }
    }
    redirect(ctx.res, `/procurement/comenzi/${id}${eroare ? "?eroare=" + encodeURIComponent(eroare.slice(0, 160)) : ""}`);
  });

  // ---- recepția -----------------------------------------------------------
  router.post("/procurement/comenzi/:id/receptie", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    const b = ctx.body || {};
    const ids = asArray(b["linie_id[]"]);
    const primite = asArray(b["primit[]"]);
    const tot = text(b.tot) === "1";

    const linii = await liniile(id);
    const dupaId = new Map(linii.map((l) => [String(l.id), l]));

    for (let i = 0; i < ids.length; i++) {
      const l = dupaId.get(String(ids[i]));
      if (!l) continue;
      let v;
      if (tot) v = nr(l.cantitate);
      else {
        const s = text(primite[i]).replace(",", ".");
        // Gol înseamnă „nu schimb nimic", nu „zero". Altfel o recepție
        // parțială în care completezi o singură linie ar șterge tăcut ce era
        // deja înregistrat pe celelalte.
        if (s === "") continue;
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0) continue;
        v = n;
      }
      await db.prepare("UPDATE comenzi_furnizor_linii SET cantitate_primita = ? WHERE id = ?").run(v, l.id);
      l.cantitate_primita = v;
    }

    const status = L.statusDupaReceptie(linii, "trimisa");
    const dataRec = text(b.data_receptie).slice(0, 10) || azi();
    await db
      .prepare("UPDATE comenzi_furnizor SET status = ?, data_receptie = CASE WHEN ? = 'primita' OR ? = 'partial' THEN ? ELSE data_receptie END WHERE id = ?")
      .run(status, status, status, dataRec, id);
    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });

  // Anularea nu șterge: comanda rămâne în istoric, dar iese din totaluri și
  // din istoricul de preț. O comandă ștearsă ar lăsa o gaură în numerotare pe
  // care nimeni n-ar mai ști s-o explice.
  router.post("/procurement/comenzi/:id/anuleaza", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!poateTrimite(ctx.user)) return redirect(ctx.res, `/procurement/comenzi/${id}`);
    await db.prepare("UPDATE comenzi_furnizor SET status = 'anulata' WHERE id = ?").run(id);
    redirect(ctx.res, `/procurement/comenzi/${id}`);
  });
}

module.exports = { register, EXPEDITOR, MONEDE, UNITATI };
