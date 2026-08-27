"use strict";
// Calculatorul de preț.
//
// Ideea: fiecare categorie de produs (folie stretch, bandă adezivă, …) are
// alt fel de a-și socoti costul. În loc să scriu în cod formula fiecăreia —
// și să aștept un deploy la fiecare schimbare — categoria își ține singură
// câmpurile și formula, în baza de date. Vali le poate schimba din pagină.
//
// Formula se evaluează cu un mic parser propriu, nu cu eval: acceptă doar
// numere, numele câmpurilor, + - * / ( ) și funcțiile min/max/rotund. Ce nu
// recunoaște, refuză — o formulă e o formulă, nu un loc de rulat cod.
const db = require("../lib/db");
const { esc, money, layout, table, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// --- evaluator de formule -------------------------------------------------
function evalueaza(formula, valori) {
  const src = String(formula || "");
  let i = 0;
  const spatii = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  function expresie() {
    let v = termen();
    for (;;) {
      spatii();
      const c = src[i];
      if (c === "+") { i++; v += termen(); }
      else if (c === "-") { i++; v -= termen(); }
      else return v;
    }
  }
  function termen() {
    let v = factor();
    for (;;) {
      spatii();
      const c = src[i];
      if (c === "*") { i++; v *= factor(); }
      else if (c === "/") { i++; const d = factor(); v = d === 0 ? 0 : v / d; }
      else return v;
    }
  }
  function factor() {
    spatii();
    if (src[i] === "-") { i++; return -factor(); }
    if (src[i] === "(") {
      i++;
      const v = expresie();
      spatii();
      if (src[i] === ")") i++;
      return v;
    }
    const numar = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
    if (numar) { i += numar[0].length; return parseFloat(numar[0]); }
    const nume = /^[a-zA-Z_ăâîșțĂÂÎȘȚ][a-zA-Z0-9_ăâîșțĂÂÎȘȚ]*/.exec(src.slice(i));
    if (nume) {
      i += nume[0].length;
      spatii();
      if (src[i] === "(") {
        i++;
        const argumente = [];
        for (;;) {
          argumente.push(expresie());
          spatii();
          if (src[i] === ",") { i++; continue; }
          break;
        }
        spatii();
        if (src[i] === ")") i++;
        const f = nume[0].toLowerCase();
        if (f === "min") return Math.min(...argumente);
        if (f === "max") return Math.max(...argumente);
        if (f === "rotund") return Math.round(argumente[0] * 100) / 100;
        throw new Error(`funcția „${nume[0]}" nu e cunoscută`);
      }
      if (!(nume[0] in valori)) throw new Error(`câmpul „${nume[0]}" nu există în categoria asta`);
      return Number(valori[nume[0]]) || 0;
    }
    throw new Error(`nu înțeleg formula de la poziția ${i}`);
  }
  const rezultat = expresie();
  spatii();
  if (i < src.length) throw new Error(`nu înțeleg formula de la „${src.slice(i, i + 12)}"`);
  return rezultat;
}

function campuri(cat) {
  try {
    const c = JSON.parse(cat.campuri || "[]");
    return Array.isArray(c) ? c : [];
  } catch (e) {
    return [];
  }
}

// Categorii de pornire. Formulele sunt puse cu bun-simț, nu cu adevărul din
// fabrică — Vali le înlocuiește din pagină când îmi dă cifrele lui.
const IMPLICITE = [
  {
    nume: "Folie stretch",
    um: "rolă",
    descriere: "Cost pe rolă, pornind de la greutatea netă de material.",
    campuri: JSON.stringify([
      { cheie: "greutate_neta", eticheta: "Greutate netă", unitate: "kg/rolă", implicit: 1.5 },
      { cheie: "pret_material", eticheta: "Preț material", unitate: "lei/kg", implicit: 6.5 },
      { cheie: "manopera", eticheta: "Manoperă", unitate: "lei/kg", implicit: 0.8 },
      { cheie: "tub", eticheta: "Tub + ambalare", unitate: "lei/rolă", implicit: 0.6 },
      { cheie: "transport", eticheta: "Transport", unitate: "lei/rolă", implicit: 0.2 },
    ]),
    formula_cost: "greutate_neta * (pret_material + manopera) + tub + transport",
  },
  {
    nume: "Bandă adezivă",
    um: "rolă",
    descriere: "Cost pe rolă, din suprafața de bandă.",
    campuri: JSON.stringify([
      { cheie: "lungime", eticheta: "Lungime", unitate: "m", implicit: 66 },
      { cheie: "latime", eticheta: "Lățime", unitate: "mm", implicit: 48 },
      { cheie: "cost_mp", eticheta: "Cost material", unitate: "lei/mp", implicit: 0.55 },
      { cheie: "tub", eticheta: "Tub + ambalare", unitate: "lei/rolă", implicit: 0.35 },
    ]),
    formula_cost: "lungime * latime / 1000 * cost_mp + tub",
  },
  {
    nume: "Produs din stoc (cost cunoscut)",
    um: "buc",
    descriere: "Pentru produsele care se cumpără gata făcute — costul e prețul de achiziție.",
    campuri: JSON.stringify([
      { cheie: "cost_achizitie", eticheta: "Cost achiziție", unitate: "lei/buc", implicit: 0 },
      { cheie: "manipulare", eticheta: "Manipulare + transport", unitate: "lei/buc", implicit: 0 },
    ]),
    formula_cost: "cost_achizitie + manipulare",
  },
];

async function seed() {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM calculator_categorii").get();
  if (Number(n.n || 0) > 0) return;
  for (const c of IMPLICITE) {
    await db
      .prepare(
        `INSERT INTO calculator_categorii (nume, descriere, campuri, formula_cost, um, activ, actualizat_la)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(c.nume, c.descriere, c.campuri, c.formula_cost, c.um, new Date().toISOString().slice(0, 19).replace("T", " "));
  }
  console.log("[calculator] categorii implicite create");
}

function register(router) {
  router.get("/calculator", async (ctx) => {
    const categorii = await db.prepare("SELECT * FROM calculator_categorii WHERE activ = 1 ORDER BY nume").all();
    const alesId = parseInt((ctx.query && ctx.query.categorie) || "", 10) || (categorii[0] ? categorii[0].id : null);
    const cat = categorii.find((c) => Number(c.id) === Number(alesId)) || null;
    const lista = cat ? campuri(cat) : [];

    // Valorile vin din query, ca să se poată da un link cu calculul făcut.
    const valori = {};
    for (const c of lista) {
      const din = ctx.query && ctx.query[c.cheie];
      valori[c.cheie] = din !== undefined && din !== "" ? Number(din) : Number(c.implicit) || 0;
    }
    const marja = ctx.query && ctx.query.marja !== undefined && ctx.query.marja !== "" ? Number(ctx.query.marja) : 25;
    const cantitate = ctx.query && ctx.query.cantitate ? Number(ctx.query.cantitate) : 1;

    let cost = null;
    let eroare = null;
    if (cat) {
      try {
        cost = evalueaza(cat.formula_cost, valori);
      } catch (e) {
        eroare = e.message;
      }
    }
    // Marja e marjă comercială pe preț, nu adaos pe cost: la 25% marjă,
    // costul reprezintă 75% din prețul de vânzare.
    const pret = cost === null ? null : marja >= 100 ? null : cost / (1 - marja / 100);
    const adaos = cost && pret ? pret - cost : null;

    const selectCat = `<select name="categorie" onchange="this.form.submit()">${categorii
      .map((c) => `<option value="${c.id}"${Number(c.id) === Number(alesId) ? " selected" : ""}>${esc(c.nume)}</option>`)
      .join("")}</select>`;

    const campuriHtml = lista
      .map(
        (c) => `<label class="field"><span>${esc(c.eticheta || c.cheie)} <span style="color:var(--text-muted)">${esc(c.unitate || "")}</span></span>
          <input type="number" step="0.0001" name="${esc(c.cheie)}" value="${esc(String(valori[c.cheie]))}"></label>`
      )
      .join("");

    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume LIMIT 3000").all();
    const oferteDeschise = await db
      .prepare(
        `SELECT o.id, o.numar, p.nume AS client FROM oferte o LEFT JOIN parteneri p ON p.id = o.partener_id
         WHERE o.status IN ('ciorna','trimisa','draft','noua') ORDER BY o.id DESC LIMIT 50`
      )
      .all()
      .catch(() => []);

    const rezultatHtml =
      eroare !== null
        ? `<p class="badge rosu">Formula categoriei nu se poate calcula: ${esc(eroare)}</p>`
        : cost === null
          ? ""
          : `<div class="cards">
               <div class="card"><div class="label">Cost producție / bucată</div><div class="value">${money(cost)}</div></div>
               <div class="card"><div class="label">Marjă</div><div class="value">${esc(String(marja))}%</div>
                 <div style="font-size:12px;color:var(--text-muted)">adaos ${adaos === null ? "—" : money(adaos)}</div></div>
               <div class="card"><div class="label">Preț de vânzare</div><div class="value">${pret === null ? "—" : money(pret)}</div>
                 <div style="font-size:12px;color:var(--text-muted)">fără TVA</div></div>
               <div class="card"><div class="label">Total pe ${esc(String(cantitate))} ${esc(cat.um || "buc")}</div>
                 <div class="value">${pret === null ? "—" : money(pret * cantitate)}</div></div>
             </div>`;

    const adaugaHtml =
      pret === null || !cat
        ? ""
        : `<h2>Pune-l într-o ofertă sau într-o comandă</h2>
           <form method="post" action="/calculator/adauga" class="form" style="max-width:820px">
             <input type="hidden" name="denumire" value="${esc(cat.nume)}">
             <input type="hidden" name="pret" value="${pret.toFixed(4)}">
             <input type="hidden" name="cost" value="${cost.toFixed(4)}">
             <input type="hidden" name="um" value="${esc(cat.um || "buc")}">
             <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
               <label class="field"><span>Denumirea de pe document</span><input name="denumire_afisata" value="${esc(cat.nume)}" required></label>
               <label class="field"><span>Cantitate</span><input type="number" step="0.001" name="cantitate" value="${esc(String(cantitate))}" required></label>
               <label class="field"><span>Client</span>
                 <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
               </label>
             </div>
             <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
               <label class="field"><span>Unde</span>
                 <select name="destinatie">
                   <option value="oferta_noua">Ofertă nouă</option>
                   ${oferteDeschise.map((o) => `<option value="oferta:${o.id}">Ofertă ${esc(o.numar || "#" + o.id)} — ${esc(o.client || "")}</option>`).join("")}
                   <option value="comanda_noua">Comandă nouă</option>
                 </select>
               </label>
               <label class="field"><span>Termen cerut (pentru comandă)</span><input type="date" name="data_livrare_ceruta"></label>
             </div>
             <div class="form-actions"><button class="btn" type="submit">Adaugă</button></div>
           </form>`;

    const body = `
      ${subnavCrm("/calculator", ctx.user)}
      <form method="get" action="/calculator" class="form" style="max-width:820px">
        <label class="field"><span>Categorie de produs</span>${selectCat}</label>
        ${cat && cat.descriere ? `<p style="color:var(--text-muted);margin-top:-6px">${esc(cat.descriere)}</p>` : ""}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">${campuriHtml}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Marjă comercială (%)</span><input type="number" step="0.1" name="marja" value="${esc(String(marja))}"></label>
          <label class="field"><span>Cantitate</span><input type="number" step="0.001" name="cantitate" value="${esc(String(cantitate))}"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Calculează</button>
          ${ctx.user && ctx.user.rol === "admin" ? `<a class="btn secondary" href="/calculator/categorii">Formule &amp; categorii</a>` : ""}
        </div>
      </form>
      ${rezultatHtml}
      ${adaugaHtml}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Calculator preț", active: "/crm", body }));
  });

  // Adaugă rezultatul într-o ofertă sau comandă.
  router.post("/calculator/adauga", async (ctx) => {
    const b = ctx.body || {};
    const partenerId = parseInt(b.partener_id, 10) || null;
    const cantitate = Number(b.cantitate) || 1;
    const pret = Number(b.pret) || 0;
    const denumire = String(b.denumire_afisata || b.denumire || "Produs").trim().slice(0, 200);
    const um = String(b.um || "buc").slice(0, 20);
    if (!partenerId) return redirect(ctx.res, "/calculator");

    // Produsul trebuie să existe ca rând, ca să se poată lega linia.
    let produs = await db.prepare("SELECT id FROM produse WHERE LOWER(denumire) = LOWER(?)").get(denumire);
    if (!produs) {
      const ins = await db
        .prepare("INSERT INTO produse (denumire, unitate_masura, pret_vanzare, pret_achizitie) VALUES (?, ?, ?, ?) RETURNING id")
        .run(denumire, um, pret, Number(b.cost) || 0);
      produs = { id: ins.lastInsertRowid };
    } else {
      await db.prepare("UPDATE produse SET pret_vanzare = ?, pret_achizitie = ? WHERE id = ?").run(pret, Number(b.cost) || 0, produs.id);
    }

    const dest = String(b.destinatie || "oferta_noua");
    const acum = new Date().toISOString().slice(0, 19).replace("T", " ");

    if (dest.startsWith("oferta:")) {
      const ofertaId = parseInt(dest.split(":")[1], 10);
      await db
        .prepare("INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar) VALUES (?, ?, ?, ?, ?, ?)")
        .run(ofertaId, produs.id, denumire, um, cantitate, pret);
      return redirect(ctx.res, `/oferte/${ofertaId}`);
    }

    if (dest === "comanda_noua") {
      const ins = await db
        .prepare(
          `INSERT INTO comenzi (partener_id, data, status, agent_id, data_livrare_ceruta, observatii)
           VALUES (?, ?, 'noua', ?, ?, ?) RETURNING id`
        )
        .run(partenerId, acum, ctx.user ? ctx.user.id : null, String(b.data_livrare_ceruta || "") || null, "creată din calculatorul de preț");
      const comandaId = ins.lastInsertRowid;
      await db
        .prepare("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, ?)")
        .run(comandaId, produs.id, cantitate, pret);
      return redirect(ctx.res, `/comenzi/${comandaId}`);
    }

    const ins = await db
      .prepare(
        `INSERT INTO oferte (partener_id, numar, titlu, status, agent_id, observatii, creat_la)
         VALUES (?, ?, ?, 'ciorna', ?, ?, ?) RETURNING id`
      )
      .run(partenerId, null, denumire, ctx.user ? ctx.user.id : null, "creată din calculatorul de preț", acum);
    const ofertaId = ins.lastInsertRowid;
    await db
      .prepare("UPDATE oferte SET numar = ?, radacina_id = ? WHERE id = ?")
      .run(require("./oferte").nrDoc("OF", ofertaId), ofertaId, ofertaId);
    await db
      .prepare("INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ofertaId, produs.id, denumire, um, cantitate, pret);
    redirect(ctx.res, `/oferte/${ofertaId}`);
  });

  // --- întreținerea formulelor (admin) ------------------------------------
  router.get("/calculator/categorii", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator");
    const categorii = await db.prepare("SELECT * FROM calculator_categorii ORDER BY nume").all();
    const body = `
      ${subnavCrm("/calculator", ctx.user)}
      <p style="max-width:760px;color:var(--text-muted)">
        Câmpurile sunt o listă JSON: <code>[{"cheie":"greutate_neta","eticheta":"Greutate netă","unitate":"kg","implicit":1.5}]</code>.
        Formula le folosește după <code>cheie</code> și acceptă <code>+ - * / ( )</code> plus <code>min()</code>, <code>max()</code>,
        <code>rotund()</code>. Rezultatul e costul de producție pe o bucată.
      </p>
      ${table(
        ["Categorie", "UM", "Formulă", "Activă", ""],
        categorii.map((c) => [
          esc(c.nume),
          esc(c.um || ""),
          `<code>${esc(c.formula_cost || "")}</code>`,
          c.activ ? '<span class="badge verde">da</span>' : '<span class="badge gri">nu</span>',
          `<a class="btn small secondary" href="/calculator/categorii/${c.id}">Editează</a>`,
        ])
      )}
      <h2>Categorie nouă</h2>
      <form method="post" action="/calculator/categorii" class="form" style="max-width:820px">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field"><span>Nume</span><input name="nume" required></label>
          <label class="field"><span>Unitate de măsură</span><input name="um" value="buc"></label>
        </div>
        <label class="field"><span>Descriere</span><input name="descriere"></label>
        <label class="field"><span>Câmpuri (JSON)</span><textarea name="campuri" rows="4">[{"cheie":"cost","eticheta":"Cost","unitate":"lei","implicit":0}]</textarea></label>
        <label class="field"><span>Formulă cost</span><input name="formula_cost" value="cost"></label>
        <div class="form-actions"><button class="btn" type="submit">Adaugă categoria</button></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Formule calculator", active: "/crm", body }));
  });

  router.post("/calculator/categorii", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator");
    const b = ctx.body || {};
    await db
      .prepare(
        `INSERT INTO calculator_categorii (nume, descriere, campuri, formula_cost, um, activ, actualizat_la)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        String(b.nume || "").trim().slice(0, 120),
        String(b.descriere || "").trim().slice(0, 400) || null,
        String(b.campuri || "[]"),
        String(b.formula_cost || "0"),
        String(b.um || "buc").slice(0, 20),
        new Date().toISOString().slice(0, 19).replace("T", " ")
      );
    redirect(ctx.res, "/calculator/categorii");
  });

  router.get("/calculator/categorii/:id", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator");
    const c = await db.prepare("SELECT * FROM calculator_categorii WHERE id = ?").get(parseInt(ctx.params.id, 10));
    if (!c) return redirect(ctx.res, "/calculator/categorii");
    const body = `
      ${subnavCrm("/calculator", ctx.user)}
      <form method="post" action="/calculator/categorii/${c.id}" class="form" style="max-width:820px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
          <label class="field"><span>Nume</span><input name="nume" value="${esc(c.nume)}" required></label>
          <label class="field"><span>UM</span><input name="um" value="${esc(c.um || "buc")}"></label>
          <label class="field"><span>Activă</span>
            <select name="activ"><option value="1"${c.activ ? " selected" : ""}>da</option><option value="0"${c.activ ? "" : " selected"}>nu</option></select>
          </label>
        </div>
        <label class="field"><span>Descriere</span><input name="descriere" value="${esc(c.descriere || "")}"></label>
        <label class="field"><span>Câmpuri (JSON)</span><textarea name="campuri" rows="6">${esc(c.campuri || "[]")}</textarea></label>
        <label class="field"><span>Formulă cost</span><input name="formula_cost" value="${esc(c.formula_cost || "")}"></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button> <a class="btn secondary" href="/calculator/categorii">Înapoi</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Editare categorie", active: "/crm", body }));
  });

  router.post("/calculator/categorii/:id", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/calculator");
    const b = ctx.body || {};
    await db
      .prepare(
        `UPDATE calculator_categorii SET nume = ?, descriere = ?, campuri = ?, formula_cost = ?, um = ?, activ = ?, actualizat_la = ?
         WHERE id = ?`
      )
      .run(
        String(b.nume || "").trim().slice(0, 120),
        String(b.descriere || "").trim().slice(0, 400) || null,
        String(b.campuri || "[]"),
        String(b.formula_cost || "0"),
        String(b.um || "buc").slice(0, 20),
        String(b.activ) === "0" ? 0 : 1,
        new Date().toISOString().slice(0, 19).replace("T", " "),
        parseInt(ctx.params.id, 10)
      );
    redirect(ctx.res, "/calculator/categorii");
  });
}

module.exports = { register, seed, evalueaza };
