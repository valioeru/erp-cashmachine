"use strict";
// Procurement — ce ne oferă furnizorii, la ce preț și când.
//
// DE CE există modulul ăsta, în cuvintele lui Vali: „istoric oferte … produse
// și furnizorii care le oferă și ofertele lor la diverse date … pe categorii
// mai mari … sus în fiecare categorie ofertele mai recente … să poți căuta un
// anume produs … să adaugi manual o ofertă".
//
// Problema reală: ofertele de la furnizori trăiesc în inbox. Pe 19.09.2026, în
// zece zile, veniseră prețuri pentru folie stretch jumbo de la Rotapack (1,89
// €/kg la 15µ), Denelavas (1,51 €/kg) și local Teraplast/Opal (1,39 €/kg),
// plus cinci RFQ-uri de bandă BOPP trimise în Italia, Franța și Turcia. Peste
// trei luni, când vine iar momentul să cumperi, nimeni nu mai știe cine cât a
// cerut și când. Aici rămân, una sub alta, pe același articol.
//
// Cuvântul cheie e ARTICOL, nu produs. „Folie stretch jumbo 15µ" e un lucru pe
// care ți-l oferteaza cinci fabrici, fiecare cu alt nume comercial și altă
// unitate. Articolul e cererea ta; oferta e răspunsul lor. Legătura cu
// nomenclatorul de produse rămâne opțională — marfa pe care n-ai cumpărat-o
// încă nici nu are cum să fie în nomenclator.
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);
const azi = () => new Date().toISOString().slice(0, 10);

// Categoriile mari cu care pornește lista. Sunt doar un punct de plecare —
// se adaugă altele din pagină, iar astea se pot redenumi sau scoate.
const CATEGORII_IMPLICITE = [
  ["Folie stretch & polietilenă", 10],
  ["Bandă adezivă", 20],
  ["Cutii & carton", 30],
  ["Pungi, saci & plicuri", 40],
  ["Materie primă (granule, masterbatch)", 50],
  ["Transport & logistică", 60],
  ["Utilaje, piese & consumabile", 70],
  ["Servicii", 80],
  ["Altele", 999],
];

const MONEDE = ["EUR", "RON", "USD"];
const UNITATI = ["kg", "buc", "ml", "mp", "tonă", "rolă", "palet", "set", "oră", "transport"];

// Cursul e o singură cifră, ținută în setări, folosită DOAR ca să poți compara
// o ofertă în euro cu una în lei. Nu se inventează: dacă nu e pus, rămâne
// 5,25 (același cu cel din calculatorul de pungi) și scrie pe pagină la ce
// curs s-a făcut comparația, ca nimeni să nu creadă că e un preț oficial.
const CURS_IMPLICIT = 5.25;

async function curs() {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'ach_curs_eur'").get();
    const v = Number(String((r && r.valoare) || "").replace(",", "."));
    return v > 0 ? v : CURS_IMPLICIT;
  } catch (e) {
    return CURS_IMPLICIT;
  }
}

// Prețul adus în lei, ca să se poată compara mere cu mere. USD se apropie de
// euro printr-un raport fix — e o aproximare, și scrie pe pagină că e.
function inLei(pret, moneda, c) {
  const p = nr(pret);
  if (moneda === "RON") return p;
  if (moneda === "USD") return p * c * 0.92;
  return p * c;
}

let seminteFacute = false;
async function asiguraCategorii() {
  if (seminteFacute) return;
  const n = nr((await db.prepare("SELECT COUNT(*) AS n FROM ach_categorii").get()).n);
  if (n === 0) {
    for (const [nume, ordine] of CATEGORII_IMPLICITE) {
      await db.prepare("INSERT INTO ach_categorii (nume, ordine) VALUES (?, ?)").run(nume, ordine);
    }
  }
  seminteFacute = true;
}

// Oferta „vie": nu e ștearsă și, dacă are valabilitate, n-a expirat.
const CLAUZA_VALABILA = "(o.valabil_pana IS NULL OR o.valabil_pana = '' OR o.valabil_pana >= ?)";

function badgeVechime(data, aziStr) {
  const zile = Math.round((Date.parse(aziStr) - Date.parse(String(data).slice(0, 10))) / 86400000);
  if (!isFinite(zile)) return "";
  if (zile <= 14) return '<span class="badge verde">nouă</span>';
  if (zile <= 60) return `<span class="badge galben">${zile} zile</span>`;
  return `<span class="badge gri">${Math.round(zile / 30)} luni</span>`;
}

function pretText(o) {
  return `${Number(o.pret).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${esc(o.moneda)}${o.um ? " / " + esc(o.um) : ""}`;
}

function numeFurnizor(o) {
  const nume = o.furnizor_nume || o.furnizor_text || "—";
  return o.furnizor_id ? `<a href="/parteneri/${o.furnizor_id}">${esc(nume)}</a>` : esc(nume);
}

function register(router) {
  // ---- pagina principală: pe categorii, cu cele mai noi sus ---------------
  router.get("/procurement", async (ctx) => {
    await asiguraCategorii();
    const aziStr = azi();
    const c = await curs();
    const cauta = String(ctx.query.q || "").trim();
    const catAleasa = parseInt(ctx.query.categorie, 10) || null;
    const furnizorCautat = String(ctx.query.furnizor || "").trim();
    const doarValabile = String(ctx.query.valabile ?? "1") !== "0";
    const luni = Math.min(60, Math.max(1, parseInt(ctx.query.luni || "12", 10) || 12));
    const deLa = new Date(Date.now() - luni * 30.5 * 86400000).toISOString().slice(0, 10);

    const unde = ["o.activ = 1", "a.activ = 1", "o.data_ofertei >= ?"];
    const args = [deLa];
    if (doarValabile) {
      unde.push(CLAUZA_VALABILA);
      args.push(aziStr);
    }
    if (catAleasa) {
      unde.push("a.categorie_id = ?");
      args.push(catAleasa);
    }
    if (cauta) {
      unde.push("(a.nume ILIKE ? OR a.specificatie ILIKE ? OR o.observatii ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    if (furnizorCautat) {
      unde.push("(COALESCE(p.nume, o.furnizor_text, '') ILIKE ?)");
      args.push(`%${furnizorCautat}%`);
    }

    const oferte = await db
      .prepare(
        `SELECT o.*, a.nume AS articol, a.um AS articol_um, a.categorie_id, cat.nume AS categorie,
                p.nume AS furnizor_nume
           FROM ach_oferte o
           JOIN ach_articole a ON a.id = o.articol_id
           LEFT JOIN ach_categorii cat ON cat.id = a.categorie_id
           LEFT JOIN parteneri p ON p.id = o.furnizor_id
          WHERE ${unde.join(" AND ")}
          ORDER BY o.data_ofertei DESC, o.id DESC`
      )
      .all(...args);

    const categorii = await db.prepare("SELECT * FROM ach_categorii WHERE activ = 1 ORDER BY ordine, nume").all();

    // Gruparea pe categorii. În fiecare, ofertele stau deja în ordinea
    // descrescătoare a datei — cererea lui Vali: „sus … ofertele mai recente".
    const peCategorie = new Map();
    for (const o of oferte) {
      const cheie = o.categorie || "Fără categorie";
      if (!peCategorie.has(cheie)) peCategorie.set(cheie, []);
      peCategorie.get(cheie).push(o);
    }

    const furnizoriDistincti = new Set(oferte.map((o) => o.furnizor_nume || o.furnizor_text).filter(Boolean));
    const articoleDistincte = new Set(oferte.map((o) => o.articol_id));

    const optCategorii = categorii
      .map((x) => `<option value="${x.id}"${catAleasa === x.id ? " selected" : ""}>${esc(x.nume)}</option>`)
      .join("");

    const bloc = (numeCat, lista) => {
      // Cel mai bun preț din categorie n-are sens: „folie" și „bandă" nu se
      // compară. Se compară pe articol, în pagina articolului.
      const randuri = lista.slice(0, 12).map((o) => [
        `${esc(String(o.data_ofertei).slice(0, 10))} ${badgeVechime(o.data_ofertei, aziStr)}`,
        `<a href="/procurement/articol/${o.articol_id}"><strong>${esc(o.articol)}</strong></a>${
          o.specificatie ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(o.specificatie)}</span>` : ""
        }`,
        numeFurnizor(o),
        `<strong>${pretText(o)}</strong>`,
        o.cantitate_min ? esc(String(o.cantitate_min)) + (o.um ? " " + esc(o.um) : "") : "",
        o.valabil_pana ? esc(String(o.valabil_pana).slice(0, 10)) : '<span style="color:var(--text-muted)">fără termen</span>',
        o.email_subiect
          ? `<span title="${esc(o.email_subiect)}" style="font-size:12px">${esc(o.sursa)}</span>`
          : `<span style="font-size:12px">${esc(o.sursa)}</span>`,
      ]);
      return `
        <h2 style="margin-top:26px">${esc(numeCat)} <span style="font-weight:400;font-size:14px;color:var(--text-muted)">· ${lista.length} ${
        lista.length === 1 ? "ofertă" : "oferte"
      }</span></h2>
        ${table(["Data", "Articol", "Furnizor", "Preț", "Cant. minimă", "Valabilă până", "Sursa"], randuri)}
        ${lista.length > 12 ? `<p style="font-size:12px;color:var(--text-muted)">Se văd cele mai noi 12. Filtrează pe categorie ca să le vezi pe toate.</p>` : ""}
      `;
    };

    const body = `
      <div class="toolbar">
        <a href="/procurement/nou" class="btn">+ Ofertă nouă</a>
        <a href="/procurement/articole" class="btn secondary">Articole & categorii</a>
      </div>

      <form class="filtre" method="get" action="/procurement">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="caută un articol, de exemplu stretch 15" style="min-width:260px">
        <input type="search" name="furnizor" value="${esc(furnizorCautat)}" placeholder="furnizor">
        <select name="categorie" onchange="this.form.submit()">
          <option value="">toate categoriile</option>
          ${optCategorii}
        </select>
        <select name="valabile" onchange="this.form.submit()">
          <option value="1"${doarValabile ? " selected" : ""}>doar ofertele valabile</option>
          <option value="0"${doarValabile ? "" : " selected"}>și cele expirate</option>
        </select>
        <select name="luni" onchange="this.form.submit()">
          ${[3, 6, 12, 24, 60].map((l) => `<option value="${l}"${luni === l ? " selected" : ""}>ultimele ${l} de luni</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Caută</button>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Oferte în perioadă</div><div class="value">${oferte.length}</div></div>
        <div class="card"><div class="label">Articole ofertate</div><div class="value">${articoleDistincte.size}</div></div>
        <div class="card"><div class="label">Furnizori</div><div class="value">${furnizoriDistincti.size}</div></div>
      </div>

      ${
        oferte.length === 0
          ? `<p>Nicio ofertă în filtrul ales. <a href="/procurement/nou">Adaugă prima</a>.</p>`
          : [...peCategorie.entries()].map(([k, v]) => bloc(k, v)).join("")
      }

      <p style="font-size:12px;color:var(--text-muted);margin-top:24px">
        Comparațiile între monede se fac la cursul de ${esc(String(c).replace(".", ","))} lei/euro, setat în
        <a href="/procurement/articole">Articole &amp; categorii</a>. E doar pentru comparație, nu un curs oficial.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Procurement — oferte de la furnizori", active: "/procurement", body }));
  });

  // ---- un articol: toți furnizorii, tot istoricul de preț ----------------
  router.get("/procurement/articol/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const aziStr = azi();
    const c = await curs();
    const a = await db
      .prepare(
        `SELECT a.*, cat.nume AS categorie, pr.denumire AS produs, pr.pret_achizitie
           FROM ach_articole a
           LEFT JOIN ach_categorii cat ON cat.id = a.categorie_id
           LEFT JOIN produse pr ON pr.id = a.produs_id
          WHERE a.id = ?`
      )
      .get(id);
    if (!a) return redirect(ctx.res, "/procurement");

    const oferte = await db
      .prepare(
        `SELECT o.*, p.nume AS furnizor_nume
           FROM ach_oferte o
           LEFT JOIN parteneri p ON p.id = o.furnizor_id
          WHERE o.articol_id = ? AND o.activ = 1
          ORDER BY o.data_ofertei DESC, o.id DESC`
      )
      .all(id);

    const valabile = oferte.filter((o) => !o.valabil_pana || String(o.valabil_pana).slice(0, 10) >= aziStr);
    const cuLei = valabile.map((o) => ({ ...o, lei: inLei(o.pret, o.moneda, c) })).filter((o) => o.lei > 0);
    const ceaMaiBuna = cuLei.length ? cuLei.reduce((m, o) => (o.lei < m.lei ? o : m)) : null;

    // Ultimul preț al fiecărui furnizor, ca să vezi dintr-o privire cine unde e.
    const peFurnizor = new Map();
    for (const o of oferte) {
      const cheie = o.furnizor_nume || o.furnizor_text || "—";
      if (!peFurnizor.has(cheie)) peFurnizor.set(cheie, { nume: cheie, o, nrOferte: 0, primul: o, ultimul: o });
      const g = peFurnizor.get(cheie);
      g.nrOferte++;
      // lista vine ordonată descrescător, deci primul întâlnit e cel mai nou
      if (String(o.data_ofertei) < String(g.primul.data_ofertei)) g.primul = o;
    }
    const furnizori = [...peFurnizor.values()].sort(
      (x, y) => inLei(x.ultimul.pret, x.ultimul.moneda, c) - inLei(y.ultimul.pret, y.ultimul.moneda, c)
    );

    const tendinta = (g) => {
      if (g.nrOferte < 2) return '<span style="color:var(--text-muted)">—</span>';
      const vechi = inLei(g.primul.pret, g.primul.moneda, c);
      const nou = inLei(g.ultimul.pret, g.ultimul.moneda, c);
      if (!(vechi > 0)) return "—";
      const p = ((nou - vechi) / vechi) * 100;
      if (Math.abs(p) < 0.5) return '<span style="color:var(--text-muted)">la fel</span>';
      return p > 0
        ? `<span style="color:var(--danger)">+${p.toFixed(1)}%</span>`
        : `<span style="color:var(--success)">${p.toFixed(1)}%</span>`;
    };

    const body = `
      <div class="toolbar">
        <a href="/procurement" class="btn secondary">← Toate ofertele</a>
        <a href="/procurement/nou?articol=${a.id}" class="btn">+ Ofertă nouă pe articolul ăsta</a>
      </div>

      <p style="color:var(--text-muted);margin-top:0">
        ${esc(a.categorie || "fără categorie")}${a.specificatie ? " · " + esc(a.specificatie) : ""}${
      a.produs ? ` · legat de produsul <a href="/produse">${esc(a.produs)}</a>` : ""
    }
      </p>

      <div class="cards">
        <div class="card"><div class="label">Cea mai bună ofertă valabilă</div>
          <div class="value" style="color:var(--success)">${ceaMaiBuna ? pretText(ceaMaiBuna) : "—"}</div>
          <div style="font-size:12px;color:var(--text-muted)">${ceaMaiBuna ? esc(ceaMaiBuna.furnizor_nume || ceaMaiBuna.furnizor_text || "") : "nicio ofertă valabilă"}</div>
        </div>
        <div class="card"><div class="label">Furnizori care au ofertat</div><div class="value">${peFurnizor.size}</div></div>
        <div class="card"><div class="label">Oferte în total</div><div class="value">${oferte.length}</div></div>
        ${
          a.pret_achizitie
            ? `<div class="card"><div class="label">Preț de achiziție în nomenclator</div><div class="value">${money(a.pret_achizitie)}</div></div>`
            : ""
        }
      </div>

      <h2>Unde e fiecare furnizor acum</h2>
      ${table(
        ["Furnizor", "Ultimul preț", "La data", "Oferte", "Cum s-a mișcat"],
        furnizori.map((g) => [
          g.ultimul.furnizor_id ? `<a href="/parteneri/${g.ultimul.furnizor_id}">${esc(g.nume)}</a>` : esc(g.nume),
          `<strong>${pretText(g.ultimul)}</strong>`,
          esc(String(g.ultimul.data_ofertei).slice(0, 10)),
          String(g.nrOferte),
          tendinta(g),
        ])
      )}

      <h2>Istoricul complet, ofertă cu ofertă</h2>
      ${table(
        ["Data", "Furnizor", "Preț", "Cant. minimă", "Condiții", "Livrare", "Valabilă până", "Sursa", ""],
        oferte.map((o) => [
          `${esc(String(o.data_ofertei).slice(0, 10))} ${badgeVechime(o.data_ofertei, aziStr)}`,
          numeFurnizor(o),
          pretText(o),
          o.cantitate_min ? esc(String(o.cantitate_min)) : "",
          esc(o.conditii || ""),
          esc(o.termen_livrare || ""),
          o.valabil_pana ? esc(String(o.valabil_pana).slice(0, 10)) : "",
          o.email_subiect ? `<span title="${esc(o.email_de_la || "")}">${esc(o.email_subiect.slice(0, 60))}</span>` : esc(o.sursa),
          ctx.user && ctx.user.rol === "admin"
            ? actionLinks([{ href: `/procurement/oferta/${o.id}/sterge`, label: "Scoate", method: "post", danger: true, confirm: "Scoți oferta asta din istoric?" }])
            : "",
        ])
      )}
      ${oferte.some((o) => o.observatii) ? `<h2>Note</h2><ul>${oferte.filter((o) => o.observatii).map((o) => `<li><strong>${esc(String(o.data_ofertei).slice(0, 10))}</strong> ${esc(o.furnizor_nume || o.furnizor_text || "")}: ${esc(o.observatii)}</li>`).join("")}</ul>` : ""}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: a.nume, active: "/procurement", body }));
  });

  // ---- formular de ofertă nouă -------------------------------------------
  router.get("/procurement/nou", async (ctx) => {
    await asiguraCategorii();
    const articolAles = parseInt(ctx.query.articol, 10) || null;
    const categorii = await db.prepare("SELECT * FROM ach_categorii WHERE activ = 1 ORDER BY ordine, nume").all();
    const articole = await db
      .prepare(
        `SELECT a.id, a.nume, a.um, cat.nume AS categorie FROM ach_articole a
           LEFT JOIN ach_categorii cat ON cat.id = a.categorie_id
          WHERE a.activ = 1 ORDER BY cat.ordine, a.nume`
      )
      .all();
    const furnizori = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'client' ORDER BY nume LIMIT 3000").all();

    const body = `
      <form class="form" method="post" action="/procurement/oferta" style="max-width:820px">
        <h2>Pe ce articol</h2>
        <label class="field"><span>Articol existent</span>
          <select name="articol_id">
            <option value="">— articol nou, îl scriu mai jos —</option>
            ${articole.map((a) => `<option value="${a.id}"${articolAles === a.id ? " selected" : ""}>${esc(a.categorie || "—")} · ${esc(a.nume)}</option>`).join("")}
          </select>
        </label>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
          <label class="field"><span>Articol nou (nume scurt, cum îl cauți)</span><input name="articol_nume" placeholder="ex. Folie stretch jumbo 15µ"></label>
          <label class="field"><span>Categoria lui</span>
            <select name="categorie_id">${categorii.map((c) => `<option value="${c.id}">${esc(c.nume)}</option>`).join("")}</select>
          </label>
        </div>
        <label class="field"><span>Specificație (ce anume ai cerut)</span><input name="specificatie" placeholder="ex. 1620 mm, 300% alungire, bobină 250 kg"></label>

        <h2>Cine și cât</h2>
        <div style="display:grid;grid-template-columns:2fr 2fr;gap:12px">
          <label class="field"><span>Furnizor din ERP</span>
            <select name="furnizor_id">
              <option value="">— nu e în ERP —</option>
              ${furnizori.map((f) => `<option value="${f.id}">${esc(f.nume)}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span>…sau numele lui, scris aici</span><input name="furnizor_text" placeholder="ex. Rotapack Kft (HU)"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
          <label class="field"><span>Preț</span><input type="number" step="0.0001" name="pret" required placeholder="1.89"></label>
          <label class="field"><span>Moneda</span><select name="moneda">${MONEDE.map((m) => `<option value="${m}">${m}</option>`).join("")}</select></label>
          <label class="field"><span>Pe unitate</span><select name="um">${UNITATI.map((u) => `<option value="${u}">${u}</option>`).join("")}</select></label>
          <label class="field"><span>Cantitate minimă</span><input type="number" step="0.01" name="cantitate_min" placeholder="20000"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <label class="field"><span>Data ofertei</span><input type="date" name="data_ofertei" value="${azi()}" required></label>
          <label class="field"><span>Valabilă până</span><input type="date" name="valabil_pana"></label>
          <label class="field"><span>Termen de livrare</span><input name="termen_livrare" placeholder="ex. 3 săptămâni"></label>
        </div>
        <label class="field"><span>Condiții (incoterm, plată)</span><input name="conditii" placeholder="ex. DAP Afumați, plată 30 zile"></label>
        <label class="field"><span>Observații</span><textarea name="observatii" rows="2" placeholder="ex. spune că urmează scumpire"></textarea></label>

        <div class="form-actions">
          <button class="btn" type="submit">Salvează oferta</button>
          <a href="/procurement" class="btn secondary">Renunță</a>
        </div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Ofertă nouă de la furnizor", active: "/procurement", body }));
  });

  router.post("/procurement/oferta", async (ctx) => {
    const b = ctx.body || {};
    let articolId = parseInt(b.articol_id, 10) || null;

    // Articol nou scris în formular: se creează pe loc, altfel omul ar trebui
    // să plece din pagină, să facă articolul, să se întoarcă.
    if (!articolId) {
      const nume = String(b.articol_nume || "").trim();
      if (!nume) return redirect(ctx.res, "/procurement/nou?eroare=articol");
      const r = await db
        .prepare("INSERT INTO ach_articole (nume, categorie_id, um, specificatie) VALUES (?, ?, ?, ?) RETURNING id")
        .run(nume, parseInt(b.categorie_id, 10) || null, String(b.um || "kg"), String(b.specificatie || "").trim() || null);
      articolId = r.lastInsertRowid;
    } else if (String(b.specificatie || "").trim()) {
      // specificația se completează dacă articolul n-avea una
      await db
        .prepare("UPDATE ach_articole SET specificatie = COALESCE(NULLIF(specificatie,''), ?) WHERE id = ?")
        .run(String(b.specificatie).trim(), articolId);
    }
    if (!articolId) return redirect(ctx.res, "/procurement/nou?eroare=articol");

    const pret = Number(String(b.pret || "").replace(",", "."));
    if (!(pret > 0)) return redirect(ctx.res, "/procurement/nou?eroare=pret");

    await db
      .prepare(
        `INSERT INTO ach_oferte (articol_id, furnizor_id, furnizor_text, pret, moneda, um, cantitate_min,
                                 conditii, termen_livrare, data_ofertei, valabil_pana, sursa, observatii, creat_de)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
      )
      .run(
        articolId,
        parseInt(b.furnizor_id, 10) || null,
        String(b.furnizor_text || "").trim() || null,
        pret,
        MONEDE.includes(String(b.moneda)) ? String(b.moneda) : "EUR",
        String(b.um || "").trim() || null,
        Number(String(b.cantitate_min || "").replace(",", ".")) || null,
        String(b.conditii || "").trim() || null,
        String(b.termen_livrare || "").trim() || null,
        String(b.data_ofertei || azi()).slice(0, 10),
        String(b.valabil_pana || "").slice(0, 10) || null,
        String(b.observatii || "").trim() || null,
        ctx.user ? ctx.user.id : null
      );
    redirect(ctx.res, `/procurement/articol/${articolId}`);
  });

  // Scoaterea unei oferte nu șterge rândul: îl dezactivează, ca istoricul să
  // rămână întreg dacă cineva se răzgândește.
  router.post("/procurement/oferta/:id/sterge", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/procurement");
    const o = await db.prepare("SELECT articol_id FROM ach_oferte WHERE id = ?").get(ctx.params.id);
    await db.prepare("UPDATE ach_oferte SET activ = 0 WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, o ? `/procurement/articol/${o.articol_id}` : "/procurement");
  });

  // ---- articole & categorii ----------------------------------------------
  router.get("/procurement/articole", async (ctx) => {
    await asiguraCategorii();
    const c = await curs();
    const categorii = await db
      .prepare(
        `SELECT cat.*, (SELECT COUNT(*) FROM ach_articole a WHERE a.categorie_id = cat.id AND a.activ = 1) AS nr_articole
           FROM ach_categorii cat WHERE cat.activ = 1 ORDER BY cat.ordine, cat.nume`
      )
      .all();
    const articole = await db
      .prepare(
        `SELECT a.*, cat.nume AS categorie,
                (SELECT COUNT(*) FROM ach_oferte o WHERE o.articol_id = a.id AND o.activ = 1) AS nr_oferte,
                (SELECT MAX(o.data_ofertei) FROM ach_oferte o WHERE o.articol_id = a.id AND o.activ = 1) AS ultima
           FROM ach_articole a
           LEFT JOIN ach_categorii cat ON cat.id = a.categorie_id
          WHERE a.activ = 1
          ORDER BY cat.ordine, a.nume`
      )
      .all();

    const body = `
      <div class="toolbar"><a href="/procurement" class="btn secondary">← Toate ofertele</a></div>

      <h2>Articolele pe care le cumperi</h2>
      ${table(
        ["Articol", "Categorie", "Unitate", "Oferte", "Ultima ofertă"],
        articole.map((a) => [
          `<a href="/procurement/articol/${a.id}">${esc(a.nume)}</a>${a.specificatie ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(a.specificatie)}</span>` : ""}`,
          esc(a.categorie || "—"),
          esc(a.um || ""),
          String(a.nr_oferte),
          a.ultima ? esc(String(a.ultima).slice(0, 10)) : '<span style="color:var(--text-muted)">niciuna</span>',
        ])
      )}

      <h2>Categorii</h2>
      ${table(["Categorie", "Articole", "Ordinea în pagină"], categorii.map((x) => [esc(x.nume), String(x.nr_articole), String(x.ordine)]))}
      <form class="filtre" method="post" action="/procurement/categorie">
        <input name="nume" placeholder="categorie nouă" required>
        <input type="number" name="ordine" value="500" style="width:90px" title="cu cât e mai mic, cu atât mai sus">
        <button class="btn small" type="submit">Adaugă</button>
      </form>

      <h2>Cursul folosit la comparații</h2>
      <form class="filtre" method="post" action="/procurement/curs">
        <label>1 euro =
          <input type="number" step="0.0001" name="curs" value="${esc(String(c))}" style="width:110px"> lei
        </label>
        <button class="btn small" type="submit">Salvează</button>
        <span style="font-size:12px;color:var(--text-muted)">Se folosește doar ca să poți compara o ofertă în euro cu una în lei.</span>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Articole & categorii de achiziție", active: "/procurement", body }));
  });

  router.post("/procurement/categorie", async (ctx) => {
    const nume = String((ctx.body || {}).nume || "").trim();
    if (nume) {
      await db
        .prepare("INSERT INTO ach_categorii (nume, ordine) VALUES (?, ?)")
        .run(nume, parseInt((ctx.body || {}).ordine, 10) || 500);
    }
    redirect(ctx.res, "/procurement/articole");
  });

  router.post("/procurement/curs", async (ctx) => {
    const v = Number(String((ctx.body || {}).curs || "").replace(",", "."));
    if (v > 0) {
      await db
        .prepare(
          `INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('ach_curs_eur', ?, ?)
           ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, actualizat_la = EXCLUDED.actualizat_la`
        )
        .run(String(v), new Date().toISOString().slice(0, 19).replace("T", " "));
    }
    redirect(ctx.res, "/procurement/articole");
  });
}

module.exports = { register, asiguraCategorii, inLei, CATEGORII_IMPLICITE };
