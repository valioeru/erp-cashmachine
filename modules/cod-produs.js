"use strict";
// Codul unic al produsului: pagina de configurare și produsul nou.
//
// Regula de generare NU e aici — e în lib/cod-produs.js, cu testul ei
// (test-cod-produs.js). Aici sunt doar ecranele și baza de date. Previzualizarea
// din formular cheamă tot funcția aia, printr-o rută, ca să nu existe a doua
// implementare a aceleiași reguli care să o ia razna în tăcere.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const C = require("../lib/cod-produs");
const PC = require("../lib/pret-camp");

const CALE = "/configurari/cod-produs";
const nr = (v) => {
  const x = Number(v);
  return isFinite(x) ? x : 0;
};
// Dupa o salvare ne intoarcem la familia la care lucra omul, nu la prima din
// lista. Altfel, cine adauga sase valori la „Pungă curier" ajunge de sase ori
// inapoi la folia stretch.
const inapoi = (f) => (Number(f) ? "?familie=" + Number(f) : "");

// Bucata de cod a unei valori, cum se vede în Configurări. Goală e voie doar
// la „Nepersonalizată" (vezi lib/cod-familii.js) — și trebuie să se vadă că e
// goală cu intenție, nu un <code></code> gol pe care nu-l observă nimeni.
const bucataAfisata = (v) =>
  C.curat(v.cod) ? `<code>${esc(v.cod)}</code>` : '<span class="badge">nimic în cod</span>';
// Unitatea de măsură pe care o dă valoarea produsului (hârtia: cutie / top).
const umAfisata = (v) =>
  v.um != null && String(v.um).trim() ? ` <span class="badge">UM ${esc(String(v.um).trim())}</span>` : "";

function subnav(activ) {
  const linkuri = [
    ["/configurari/date", "Date importate"],
    ["/configurari/storno", "Facturi stornate"],
    ["/configurari/adrese", "Adrese de anunț"],
    ["/configurari/ignorati", "Parteneri ignorați"],
    [CALE, "Codul produsului"],
  ];
  return `<div class="subnav">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

// Caracteristicile unei familii, cu valorile lor, gata de dat la lib/cod-produs.
//
// Familia e obligatorie la citire, nu optionala: fara ea s-ar amesteca
// „Grosime" de la folie cu „Grosime" de la cartoane si ar iesi un cod din
// bucati care n-au nicio treaba una cu alta.
async function citesteCaracteristici(totul, familieId) {
  const unde = [];
  if (!totul) unde.push("activ = 1");
  unde.push(familieId ? "familie_id = " + Number(familieId) : "familie_id IS NULL");
  const car = await db
    .prepare(`SELECT * FROM cod_caracteristici WHERE ${unde.join(" AND ")} ORDER BY ordine, id`)
    .all();
  if (!car.length) return [];
  const val = await db.prepare("SELECT * FROM cod_valori WHERE activ = 1 ORDER BY ordine, id").all();
  const peCarac = new Map();
  for (const v of val) {
    if (!peCarac.has(v.caracteristica_id)) peCarac.set(v.caracteristica_id, []);
    peCarac.get(v.caracteristica_id).push(v);
  }
  return car.map((c) => ({ ...c, valori: peCarac.get(c.id) || [] }));
}

async function familii() {
  return await db.prepare("SELECT * FROM cod_familii WHERE activ = 1 ORDER BY ordine, id").all().catch(() => []);
}

// Familiile de pornire stau in lib/cod-familii.js, ca date pure, ca sa poata
// fi verificate de un test fara baza de date.
const { START } = require("../lib/cod-familii");

async function seed() {
  const areFamilii = await db.prepare("SELECT COUNT(*) AS n FROM cod_familii").get().catch(() => null);
  if (!areFamilii) return; // tabelul nu exista inca
  if (nr(areFamilii.n) > 0) return;

  // Caracteristicile de stretch facute inainte sa existe familii stau cu
  // familie_id NULL. Nu le rescriem si nu le dublam: le mutam in familia lor.
  const orfane = await db
    .prepare("SELECT COUNT(*) AS n FROM cod_caracteristici WHERE familie_id IS NULL")
    .get()
    .catch(() => ({ n: 0 }));

  let o = 0;
  for (const [nume, exemplu, caracteristici] of START) {
    const ins = await db
      .prepare("INSERT INTO cod_familii (nume, exemplu, ordine) VALUES (?,?,?) RETURNING id")
      .run(nume, exemplu, ++o)
      .catch(() => null);
    if (!ins) continue;
    const famId = Number(ins.lastInsertRowid);

    if (nume === "Folie stretch" && nr(orfane && orfane.n) > 0) {
      await db.prepare("UPDATE cod_caracteristici SET familie_id = ? WHERE familie_id IS NULL").run(famId);
      continue;
    }

    for (const c of caracteristici) {
      const [cn, fel, um, ordine, cifre, valori, minv, maxv, inCod, oblig] = c;
      const r = await db
        .prepare(
          `INSERT INTO cod_caracteristici (familie_id, nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`
        )
        .run(famId, cn, fel, um || null, inCod === 0 ? 0 : 1, ordine, oblig === 0 ? 0 : 1,
             cifre || 0, minv == null ? null : minv, maxv == null ? null : maxv)
        .catch(() => null);
      if (!r) continue;
      let k = 0;
      for (const [valoare, cod, umValoare] of valori || []) {
        await db
          .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine, um) VALUES (?,?,?,?,?)")
          .run(Number(r.lastInsertRowid), valoare, cod, ++k, umValoare || null);
      }
    }
  }
  console.log("[cod-produs] " + START.length + " familii de produse au fost puse");
}

// Cu ce începe codul fiecărei categorii: bucățile de cod ale primei
// caracteristici care intră în cod. Două categorii care încep la fel (sau una
// cu începutul celeilalte, „P" și „PA") pot da același cod pentru două produse
// diferite — iar atunci al doilea produs ar „exista deja" și comanda ar cădea
// pe produsul altei categorii. Cererea lui Vali, 05.11.2026, ca oricine să-și
// facă singur categorii noi, face pasul ăsta ușor de greșit, deci se spune.
async function inceputuri(fam) {
  const m = new Map();
  for (const f of fam) {
    const car = (await citesteCaracteristici(false, f.id)).filter((c) => Number(c.in_cod));
    const prima = car[0];
    m.set(Number(f.id), prima
      ? { fel: prima.fel, nume: prima.nume, bucati: prima.fel === "lista" ? (prima.valori || []).map((v) => C.curat(v.cod)).filter(Boolean) : [] }
      : { fel: null, nume: null, bucati: [] });
  }
  return m;
}

function coliziuni(familieId, fam, inc) {
  const a = inc.get(Number(familieId));
  if (!a || !a.fel) return [];
  const out = [];
  if (a.fel === "numar") out.push({ numar: true, nume: a.nume });
  for (const f of fam) {
    if (Number(f.id) === Number(familieId)) continue;
    const b = inc.get(Number(f.id));
    if (!b || b.fel !== "lista") continue;
    for (const x of a.bucati) {
      for (const y of b.bucati) {
        if (x.startsWith(y) || y.startsWith(x)) out.push({ x, y, familie: f.nume });
      }
    }
  }
  return out;
}

function register(router) {
  // ---- Configurare -------------------------------------------------------
  router.get(CALE, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const fam = await familii();
    const familieId = Number(ctx.query.familie) || (fam[0] ? Number(fam[0].id) : 0);
    const familia = fam.find((f) => Number(f.id) === familieId) || null;
    const car = await citesteCaracteristici(true, familieId);
    const sab = C.sablon(car.filter((c) => c.activ));
    const exemplu = sab.map((s) => s.exemplu).join("");

    const randuri = car.map((c) => [
      `<strong>${esc(c.nume)}</strong>${c.activ ? "" : ' <span class="badge">inactivă</span>'}`,
      c.fel === "numar" ? `număr${c.um ? " (" + esc(c.um) + ")" : ""}` : c.fel === "text" ? "text liber" : "listă",
      c.fel === "numar"
        ? `${c.min_val != null ? nr(c.min_val) : "—"} … ${c.max_val != null ? nr(c.max_val) : "—"}`
        : c.fel === "text"
          ? `<span class="mic">se scrie la fiecare produs; în cod intră primele ${C.literePentru(c)} litere</span>`
          : (c.valori || []).map((v) => `${bucataAfisata(v)} ${esc(v.valoare)}${umAfisata(v)}`).join("<br>") || "—",
      c.in_cod ? '<span class="badge verde">în cod</span>' : '<span class="badge">doar în denumire</span>',
      nr(c.ordine),
      c.fel === "numar"
        ? nr(c.cifre) ? nr(c.cifre) + " cifre" : '<span class="badge rosu">lungime liberă</span>'
        : c.fel === "text" ? C.literePentru(c) + " litere" : "—",
      c.obligatoriu ? "da" : "nu",
      // Modificarea unei caracteristici, pe rândul ei.
      //
      // Până acum o caracteristică se putea doar adăuga și șterge. Ca să scoți
      // greutatea din cod trebuia ștearsă și rescrisă — iar dacă apucase să
      // nască produse, ștergerea doar o dezactiva și nu se mai putea repara
      // deloc. Cererea lui Vali, 27.10.2026.
      //
      // FELUL (listă / număr) NU se schimbă de aici: o listă trecută pe număr
      // și-ar lăsa valorile orfane, iar un număr trecut pe listă n-ar avea
      // nicio valoare — în amândouă cazurile codul ar înceta să mai iasă,
      // fără ca nimeni să înțeleagă de ce.
      `<details class="editeaza-carac">
         <summary>Modifică</summary>
         <form method="post" action="${CALE}/${c.id}/editare" class="form editeaza-form">
           <input type="hidden" name="familie_id" value="${familieId}">
           <label>Denumire<input name="nume" value="${esc(c.nume)}" required></label>
           <label>Ordine<input type="number" name="ordine" value="${nr(c.ordine)}"></label>
           ${
             c.fel === "numar"
               ? `<label>UM<input name="um" value="${esc(c.um || "")}"></label>
                  <label>Cifre în cod<input type="number" name="cifre" min="0" max="9" value="${nr(c.cifre)}"></label>
                  <label>Minim<input type="number" step="any" name="min_val" value="${c.min_val == null ? "" : nr(c.min_val)}"></label>
                  <label>Maxim<input type="number" step="any" name="max_val" value="${c.max_val == null ? "" : nr(c.max_val)}"></label>`
               : c.fel === "text"
                 ? `<label>Litere în cod<input type="number" name="cifre" min="1" max="6" value="${C.literePentru(c)}"></label>`
                 : ""
           }
           <label class="bif"><input type="checkbox" name="in_cod" value="1"${c.in_cod ? " checked" : ""}> intră în cod</label>
           <label class="bif"><input type="checkbox" name="obligatoriu" value="1"${c.obligatoriu ? " checked" : ""}> obligatorie</label>
           <label class="bif"><input type="checkbox" name="activ" value="1"${c.activ ? " checked" : ""}> activă</label>
           <button class="btn small" type="submit">Salvează</button>
         </form>
       </details>
       <form method="post" action="${CALE}/${c.id}/sterge${inapoi(familieId)}" class="inline-form"
             onsubmit="return confirm('Ștergi caracteristica „${esc(c.nume)}”? Codurile deja generate rămân cum sunt.')">
         <button class="link-btn danger" type="submit">Șterge</button>
       </form>`,
    ]);

    const admin = ctx.user.rol === "admin";
    // Unde stă categoria: ce mai lipsește ca să se poată face un produs.
    const active = car.filter((c) => c.activ);
    const inCod = active.filter((c) => Number(c.in_cod));
    const listeGoale = inCod.filter((c) => c.fel === "lista" && !(c.valori || []).some((v) => C.curat(v.cod)));
    const faraCifre = inCod.filter((c) => c.fel === "numar" && !nr(c.cifre));
    const gataDeFolosit = inCod.length > 0 && !listeGoale.length;
    const lovite = familia ? coliziuni(familia.id, fam, await inceputuri(fam)) : [];

    const body = `
      ${subnav(CALE)}
      <h1 style="margin:6px 0 2px">Categorii de produs și codul lor</h1>
      <p class="explic">
        Fiecare categorie de produs (în ERP îi spunem și „familie”) are caracteristicile ei: culoare, lățime,
        grosime… Tu le definești pe toate: care intră în cod, în ce ordine și cu ce bucată de cod. La Produs nou,
        codul se generează singur din ele, iar un produs care există deja e oprit.
      </p>
      ${ctx.query.ok ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.ok)}</p>` : ""}
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.eroare)}</p>` : ""}
      ${
        admin
          ? `<details class="categorie-noua"${fam.length ? "" : " open"} style="margin:8px 0 14px">
               <summary class="btn" style="display:inline-block;list-style:none;cursor:pointer">+ Categorie nouă de produs</summary>
               <form method="post" action="${CALE}/familie" class="form card" style="max-width:780px;margin-top:10px">
                 <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
                   <label class="field" style="flex:1 1 240px">Denumirea categoriei<input name="nume" required placeholder="Etichete autoadezive" maxlength="80"></label>
                   <label class="field" style="flex:0 1 100px">Ordine<input type="number" name="ordine" value="${fam.length + 1}"></label>
                   <label class="field" style="flex:1 1 220px">Pornește de la
                     <select name="copie_din">
                       <option value="">o categorie goală</option>
                       <option value="sablon:furnizor">furnizor + denumire (text liber)</option>
                       ${fam.map((f) => `<option value="${f.id}">copie după „${esc(f.nume)}”</option>`).join("")}
                     </select>
                   </label>
                   <button class="btn" type="submit">Creează categoria</button>
                 </div>
                 <ol class="mic" style="margin:10px 0 0 18px;color:var(--text-muted);line-height:1.6">
                   <li>Creezi categoria: goală, sau copiată după una care seamănă, cu caracteristicile și valorile ei.</li>
                   <li>Adaugi caracteristicile: listă de valori (ex. Culoare), număr (ex. Lățime, cu câte cifre are în cod)
                       sau text liber (ex. Furnizor, din care codul ia primele 2–3 litere).
                       Bifezi care intră în cod și le pui în ordine. Prima dă începutul codului, deci trebuie să fie a ei.</li>
                   <li>La fiecare listă scrii valorile, fiecare cu bucata ei de cod (ex. Alb → A).</li>
                   <li>Gata: la Produs nou alegi categoria, completezi caracteristicile, iar codul iese singur.</li>
                 </ol>
               </form>
             </details>`
          : ""
      }

      <div class="toolbar" style="flex-wrap:wrap;gap:6px">
        ${fam.length ? '<span style="font-size:13px;color:var(--text-muted);align-self:center">Categoria:</span>' : ""}
        ${fam
          .map((f) => `<a class="btn ${Number(f.id) === familieId ? "" : "secondary"}" href="${CALE}?familie=${f.id}">${esc(f.nume)}</a>`)
          .join("")}
        ${fam.length ? "" : '<span style="color:var(--text-muted)">Nicio categorie încă.</span>'}
      </div>
      ${
        familia
          ? `<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin:10px 0 4px">
               <h2 style="margin:0">${esc(familia.nume)}</h2>
               ${
                 admin
                   ? `<details class="editeaza-carac"><summary>Redenumește</summary>
                        <form method="post" action="${CALE}/familie/${familia.id}/editare" class="form editeaza-form">
                          <label>Denumire<input name="nume" value="${esc(familia.nume)}" required maxlength="80"></label>
                          <label>Ordine<input type="number" name="ordine" value="${nr(familia.ordine)}"></label>
                          <button class="btn small" type="submit">Salvează</button>
                        </form>
                      </details>
                      <form method="post" action="${CALE}/familie/${familia.id}/sterge" class="inline-form"
                            onsubmit="return confirm('Ștergi categoria „${esc(familia.nume)}” cu tot cu caracteristicile ei? Produsele deja făcute rămân cum sunt.')">
                        <button class="link-btn danger" type="submit">Șterge categoria</button>
                      </form>`
                   : ""
               }
             </div>
             <div class="detail-box" style="max-width:780px;margin:8px 0 12px">
               <strong>Cum stă categoria</strong>
               <ul style="margin:6px 0 0 18px;line-height:1.7">
                 <li>${active.length ? "✓" : "✗"} ${active.length} ${active.length === 1 ? "caracteristică" : "caracteristici"}, din care ${inCod.length} ${inCod.length === 1 ? "intră" : "intră"} în cod${inCod.length ? "" : " — bifează „intră în cod” la cel puțin una"}</li>
                 <li>${listeGoale.length ? `✗ lipsesc valorile cu bucată de cod la: ${listeGoale.map((c) => esc(c.nume)).join(", ")}` : "✓ toate listele din cod au valori cu bucata lor de cod"}</li>
                 ${faraCifre.length && !active.some((c) => c.fel === "text") ? `<li>⚠ fără număr fix de cifre: ${faraCifre.map((c) => esc(c.nume)).join(", ")} — două produse diferite pot ieși cu același cod</li>` : ""}
                 ${active.some((c) => c.fel === "text") ? `<li>ℹ are text liber (${active.filter((c) => c.fel === "text").map((c) => esc(c.nume)).join(", ")}): codul se termină cu un număr de ordine, iar produsul existent se recunoaște după tot textul scris, nu după primele litere</li>` : ""}
                 <li>${
                   gataDeFolosit
                     ? `✓ gata de folosit: <a href="/produse/nou-cu-cod${inapoi(familieId)}">Produs nou · ${esc(familia.nume)}</a>`
                     : "încă nu se poate face un produs din categoria asta: completează ce lipsește mai sus"
                 }</li>
               </ul>
             </div>
             ${
               lovite.length
                 ? `<div class="detail-box" style="max-width:780px;margin:0 0 12px;border-left:4px solid var(--danger,#b42318)">
                      <strong style="color:var(--danger,#b42318)">Atenție: începutul codului se poate lovi de altă categorie.</strong>
                      <ul style="margin:6px 0 0 18px">${lovite
                        .map((l) =>
                          l.numar
                            ? `<li>Codul începe cu un număr („${esc(l.nume)}”). Pune întâi o listă (ex. Tip) cu o bucată de cod care e doar a categoriei.</li>`
                            : `<li>„${esc(l.x)}” de aici și „${esc(l.y)}” din „${esc(l.familie)}”: un produs de aici poate ieși cu codul unui produs de acolo.</li>`
                        )
                        .join("")}</ul>
                      <div class="mic" style="margin-top:6px">Schimbă bucata de cod a primei caracteristici (din „Modifică” la valoare), cu litere pe care nu le are nicio altă categorie.</div>
                    </div>`
                 : ""
             }`
          : ""
      }
      ${
        sab.length
          ? `<div class="card" style="max-width:720px;margin-bottom:16px">
               <div class="label">Cum arată codul acum</div>
               <div class="value" style="font-family:ui-monospace,monospace">${esc(exemplu || "—")}</div>
               <div class="mic">${sab.map((s) => esc(s.nume)).join(" + ")}</div>
             </div>`
          : ""
      }
      <style>
        .editeaza-carac > summary { cursor:pointer; font-size:12px; color:var(--primary,#2f5d9c); font-weight:600; }
        .editeaza-form { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:6px 10px;
          margin-top:8px; padding:10px; border:1px solid var(--border,#e1e4e9); border-radius:8px;
          background:var(--bg,#f5f6f8); max-width:720px; }
        .editeaza-form label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text-muted); }
        .editeaza-form label.bif { flex-direction:row; align-items:center; gap:6px; font-size:12px; color:var(--text,#1c2230); }
        .editeaza-form .btn { grid-column:1 / -1; justify-self:start; }
      </style>
      <div class="tabel-scroll">${table(["Caracteristică", "Fel", "Valori / interval", "În cod", "Ordine", "Cifre", "Obligatorie", ""], randuri)}</div>

      <h2>Adaugă o caracteristică</h2>
      <form method="post" action="${CALE}/caracteristica" class="form" style="max-width:720px">
        <input type="hidden" name="familie_id" value="${familieId}">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:1 1 200px">Denumire<input name="nume" required placeholder="Culoare"></label>
          <label class="field" style="flex:0 1 150px">Fel
            <select name="fel"><option value="lista">listă de valori</option><option value="numar">număr</option><option value="text">text liber (furnizor, denumire…)</option></select>
          </label>
          <label class="field" style="flex:0 1 120px">Unitate<input name="um" placeholder="microni"></label>
          <label class="field" style="flex:0 1 100px">Ordine<input type="number" name="ordine" value="${car.length + 1}"></label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:0 1 110px">Minim<input type="number" step="any" name="min_val"></label>
          <label class="field" style="flex:0 1 110px">Maxim<input type="number" step="any" name="max_val"></label>
          <label class="field" style="flex:0 1 170px">Cifre / litere în cod<input type="number" name="cifre" value="0"></label>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px">
          „Cifre în cod" contează doar la numere, și contează mult: fără lungime fixă, grosime 1 cu lungime 200
          și grosime 12 cu lungime 0 dau amândouă <code>1200</code> — două produse diferite, același cod.
          La <strong>text liber</strong> (ex. Furnizor) se scrie câte litere din ce tastezi intră în cod — 2 sau 3; gol
          înseamnă 3. Codul primește atunci la final un număr de ordine (<code>WBVFOL01</code>, <code>WBVFOL02</code>…),
          fiindcă primele litere nu sunt unice, iar produsul existent se recunoaște după tot textul scris.
        </p>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="in_cod" value="1" checked> intră în cod</label>
        <label style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" name="obligatoriu" value="1" checked> obligatorie</label>
        <button class="btn" type="submit">Adaugă caracteristica</button>
      </form>

      ${
        car.filter((c) => c.fel === "lista").length
          ? `<h2>Adaugă valori</h2>
             <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px;max-width:720px">
               Spui câte valori are lista și le scrii pe toate deodată. Cererea lui Vali, 27.10.2026 —
               până acum se adăuga una câte una, cu o reîncărcare de pagină între ele.
             </p>
             <form method="post" action="${CALE}/valoare" class="form" style="max-width:720px">
               <input type="hidden" name="familie_id" value="${familieId}">
               <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
                 <label class="field" style="flex:0 1 220px">Caracteristica
                   <select name="caracteristica_id" required>
                     ${car.filter((c) => c.fel === "lista").map((c) => `<option value="${c.id}">${esc(c.nume)}</option>`).join("")}
                   </select>
                 </label>
                 <label class="field" style="flex:0 1 150px">Câte valori
                   <input type="number" id="cate-valori" min="1" max="40" value="3" style="width:100%">
                 </label>
                 <button class="btn secondary" type="button" onclick="faRanduriValori()">Fă rândurile</button>
               </div>
               <div id="randuri-valori" style="margin-top:10px"></div>
               <button class="btn" type="submit" style="margin-top:10px">Adaugă valorile</button>
             </form>
             <script>
             // Randurile se fac in pagina, nu pe server: altfel „cate valori"
             // ar insemna inca o reincarcare inainte sa poti scrie prima.
             function randValoare(i) {
               var d = document.createElement("div");
               d.className = "rand-valoare";
               d.innerHTML =
                 '<span class="nr-valoare">' + i + '.</span>' +
                 '<input name="valoare[]" placeholder="Verde" autocomplete="off">' +
                 '<input name="cod[]" placeholder="V" maxlength="8" autocomplete="off" class="cod-valoare">' +
                 '<input name="um[]" placeholder="UM (opțional)" maxlength="12" autocomplete="off" class="um-valoare"' +
                 ' title="Unitatea de măsură pe care o primește produsul făcut din valoarea asta — ex. cutie, top. Gol = ce scrie omul la produs.">';
               return d;
             }
             function faRanduriValori() {
               var cate = Math.max(1, Math.min(40, Number(document.getElementById("cate-valori").value) || 1));
               var gazda = document.getElementById("randuri-valori");
               // Ce-a scris omul deja nu se pierde cand mareste numarul.
               var vechi = [].slice.call(gazda.querySelectorAll(".rand-valoare")).map(function (r) {
                 var i = r.querySelectorAll("input");
                 return [i[0].value, i[1].value, i[2] ? i[2].value : ""];
               });
               gazda.innerHTML = "";
               for (var i = 0; i < cate; i++) {
                 var r = randValoare(i + 1);
                 if (vechi[i]) {
                   var inp = r.querySelectorAll("input");
                   inp[0].value = vechi[i][0];
                   inp[1].value = vechi[i][1];
                   inp[2].value = vechi[i][2];
                 }
                 gazda.appendChild(r);
               }
               var prim = gazda.querySelector("input");
               if (prim) prim.focus();
             }
             faRanduriValori();
             </script>
             <style>
               .rand-valoare { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
               .rand-valoare .nr-valoare { width:22px; text-align:right; color:var(--text-muted); font-size:12px; }
               .rand-valoare input { flex:1 1 auto; }
               .rand-valoare .cod-valoare { flex:0 0 120px; text-transform:uppercase; }
               .rand-valoare .um-valoare { flex:0 0 120px; }
               @media (max-width: 760px) {
                 .rand-valoare { flex-wrap:wrap; }
                 .rand-valoare .cod-valoare, .rand-valoare .um-valoare { flex:1 1 100px; }
               }
             </style>
             <div class="tabel-scroll">${table(
               ["Caracteristică", "Valoare", "Cod", "UM produs", ""],
               car
                 .filter((c) => c.fel === "lista")
                 .flatMap((c) =>
                   (c.valori || []).map((v) => [
                     esc(c.nume),
                     esc(v.valoare),
                     bucataAfisata(v),
                     v.um != null && String(v.um).trim() ? esc(String(v.um).trim()) : "—",
                     // Valoarea se poate și modifica, nu doar șterge și rescrie
                     // (05.11.2026): o categorie copiată pornește cu valorile
                     // celeilalte și trebuie să-și schimbe bucata de cod.
                     `<details class="editeaza-carac">
                        <summary>Modifică</summary>
                        <form method="post" action="${CALE}/valoare/${v.id}/editare" class="form editeaza-form">
                          <input type="hidden" name="familie_id" value="${familieId}">
                          <label>Valoare<input name="valoare" value="${esc(v.valoare)}" required></label>
                          <label>Bucata de cod<input name="cod" value="${esc(v.cod || "")}" maxlength="8" style="text-transform:uppercase"></label>
                          <label>UM produs<input name="um" value="${esc(v.um || "")}" maxlength="12"></label>
                          <button class="btn small" type="submit">Salvează</button>
                          <span class="mic" style="grid-column:1 / -1;color:var(--text-muted)">Produsele deja făcute își păstrează codul; noua bucată merge de acum înainte.</span>
                        </form>
                      </details>
                      <form method="post" action="${CALE}/valoare/${v.id}/sterge${inapoi(familieId)}" class="inline-form">
                        <button class="link-btn danger" type="submit">Șterge</button></form>`,
                   ])
                 )
             )}</div>`
          : ""
      }
      <p style="margin-top:18px"><a class="btn secondary" href="/produse/nou-cu-cod${inapoi(familieId)}">Produs nou${familia ? " · " + esc(familia.nume) : ""} →</a></p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Codul produsului", active: "/configurari", body }));
  });

  // Categorie nouă de produs: goală sau copiată după alta (caracteristici și
  // valori, cu tot cu bucățile de cod — pe care apoi le schimbi).
  router.post(`${CALE}/familie`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim().slice(0, 80);
    if (!nume) return redirect(ctx.res, CALE + "?eroare=" + encodeURIComponent("Scrie denumirea categoriei."));
    const toate = await familii();
    const dubla = toate.find((f) => C.curat(f.nume) === C.curat(nume));
    if (dubla) {
      return redirect(ctx.res, `${CALE}?familie=${dubla.id}&eroare=` + encodeURIComponent(`Există deja categoria „${dubla.nume}”.`));
    }
    const r = await db
      .prepare("INSERT INTO cod_familii (nume, ordine) VALUES (?, ?) RETURNING id")
      .run(nume, parseInt(b.ordine, 10) || toate.length + 1)
      .catch(() => null);
    const id = Number(r && r.lastInsertRowid) || 0;
    if (!id) return redirect(ctx.res, CALE + "?eroare=" + encodeURIComponent("Categoria nu s-a putut scrie."));

    // Furnizor + denumire, scrise liber: codul începe cu primele 3 litere ale
    // furnizorului, apoi 3 ale denumirii, apoi numărul de ordine (WBVFOL01).
    // Cererea lui Vali, 05.11.2026.
    if (b.copie_din === "sablon:furnizor") {
      for (const [cn, ordine] of [["Furnizor", 1], ["Denumire", 2]]) {
        await db
          .prepare(
            `INSERT INTO cod_caracteristici (familie_id, nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
             VALUES (?, ?, 'text', NULL, 1, ?, 1, 3, NULL, NULL)`
          )
          .run(id, cn, ordine)
          .catch(() => null);
      }
      return redirect(
        ctx.res,
        `${CALE}?familie=${id}&ok=` +
          encodeURIComponent(`Categoria „${nume}” e făcută, cu Furnizor și Denumire scrise liber. Codul iese din primele 3 litere ale fiecăruia plus un număr de ordine (ex. WBVFOL01). Poți schimba câte litere intră, din „Modifică”.`)
      );
    }
    const sursa = toate.find((f) => Number(f.id) === (parseInt(b.copie_din, 10) || -1));
    let copiate = 0;
    if (sursa) {
      for (const c of await citesteCaracteristici(false, sursa.id)) {
        const ins = await db
          .prepare(
            `INSERT INTO cod_caracteristici (familie_id, nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
             VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`
          )
          .run(id, c.nume, c.fel, c.um || null, Number(c.in_cod) ? 1 : 0, nr(c.ordine), Number(c.obligatoriu) ? 1 : 0,
               nr(c.cifre), c.min_val == null ? null : Number(c.min_val), c.max_val == null ? null : Number(c.max_val))
          .catch(() => null);
        if (!ins) continue;
        copiate++;
        for (const v of c.valori || []) {
          await db
            .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine, um) VALUES (?,?,?,?,?)")
            .run(Number(ins.lastInsertRowid), v.valoare, v.cod, nr(v.ordine), v.um || null);
        }
      }
    }
    const ok = sursa
      ? `Categoria „${nume}” e făcută, cu cele ${copiate} caracteristici din „${sursa.nume}”. Schimbă acum bucata de cod a primei caracteristici, ca codurile să nu se lovească de ale lui „${sursa.nume}”.`
      : `Categoria „${nume}” e făcută. Acum adaugă-i caracteristicile, mai jos.`;
    redirect(ctx.res, `${CALE}?familie=${id}&ok=` + encodeURIComponent(ok));
  });

  // Redenumirea și ordinea unei categorii. Produsele deja făcute nu se schimbă:
  // denumirea lor e scrisă pe ele.
  router.post(`${CALE}/familie/:id/editare`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim().slice(0, 80);
    if (!nume) return redirect(ctx.res, `${CALE}?familie=${id}&eroare=` + encodeURIComponent("Denumirea nu poate fi goală."));
    const dubla = (await familii()).find((f) => Number(f.id) !== id && C.curat(f.nume) === C.curat(nume));
    if (dubla) return redirect(ctx.res, `${CALE}?familie=${id}&eroare=` + encodeURIComponent(`Există deja categoria „${dubla.nume}”.`));
    await db.prepare("UPDATE cod_familii SET nume = ?, ordine = ? WHERE id = ?").run(nume, parseInt(b.ordine, 10) || 0, id);
    redirect(ctx.res, `${CALE}?familie=${id}&ok=` + encodeURIComponent("Salvat."));
  });

  router.post(`${CALE}/familie/:id/sterge`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const id = parseInt(ctx.params.id, 10);
    // Daca din familia asta au iesit deja produse, nu se sterge: se scoate din
    // uz. Fisa unui produs vechi trebuie sa poata arata in continuare din ce
    // bucati i s-a facut codul.
    const folosita = await db
      .prepare("SELECT COUNT(*) AS n FROM produse WHERE cod_familie_id = ?")
      .get(id)
      .catch(() => ({ n: 0 }));
    if (nr(folosita && folosita.n) > 0) {
      await db.prepare("UPDATE cod_familii SET activ = 0 WHERE id = ?").run(id);
    } else {
      // Valorile pleacă odată cu caracteristicile (ON DELETE CASCADE în bază).
      await db.prepare("DELETE FROM cod_caracteristici WHERE familie_id = ?").run(id).catch(() => null);
      await db.prepare("DELETE FROM cod_familii WHERE id = ?").run(id).catch(() => null);
    }
    redirect(ctx.res, CALE + "?ok=" + encodeURIComponent(nr(folosita && folosita.n) > 0
      ? "Categoria are deja produse, deci n-a fost ștearsă de tot: nu mai apare la Produs nou, iar produsele ei rămân cum sunt."
      : "Categoria a fost ștearsă."));
  });

  router.post(`${CALE}/caracteristica`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, CALE);
    const fel = b.fel === "numar" ? "numar" : b.fel === "text" ? "text" : "lista";
    await db
      .prepare(
        `INSERT INTO cod_caracteristici (familie_id, nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        parseInt(b.familie_id, 10) || null,
        nume,
        fel,
        fel === "text" ? null : String(b.um || "").trim() || null,
        b.in_cod ? 1 : 0,
        parseInt(b.ordine, 10) || 0,
        b.obligatoriu ? 1 : 0,
        fel === "text" ? C.literePentru({ cifre: parseInt(b.cifre, 10) || 3 }) : parseInt(b.cifre, 10) || 0,
        fel !== "numar" || b.min_val === "" || b.min_val == null ? null : Number(b.min_val),
        fel !== "numar" || b.max_val === "" || b.max_val == null ? null : Number(b.max_val)
      )
      .catch(() => null);
    redirect(ctx.res, CALE + inapoi(b.familie_id));
  });

  router.post(`${CALE}/:id/editare`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const c = await db.prepare("SELECT * FROM cod_caracteristici WHERE id = ?").get(ctx.params.id);
    if (!c) return redirect(ctx.res, CALE + inapoi(b.familie_id));
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, CALE + inapoi(b.familie_id));

    // `fel` și `familie_id` rămân cum sunt: vezi comentariul de la formular.
    // Numerele își păstrează unitatea și intervalul dacă formularul nu le-a
    // trimis (la caracteristicile de tip listă nici nu apar pe ecran).
    const areNum = c.fel === "numar";
    const areText = c.fel === "text";
    await db
      .prepare(
        `UPDATE cod_caracteristici SET nume = ?, um = ?, in_cod = ?, ordine = ?, obligatoriu = ?,
            cifre = ?, min_val = ?, max_val = ?, activ = ?
          WHERE id = ?`
      )
      .run(
        nume,
        areNum ? String(b.um || "").trim() || null : c.um,
        b.in_cod ? 1 : 0,
        parseInt(b.ordine, 10) || 0,
        b.obligatoriu ? 1 : 0,
        areNum ? parseInt(b.cifre, 10) || 0 : areText ? C.literePentru({ cifre: parseInt(b.cifre, 10) || 3 }) : c.cifre,
        areNum ? (b.min_val === "" || b.min_val == null ? null : Number(b.min_val)) : c.min_val,
        areNum ? (b.max_val === "" || b.max_val == null ? null : Number(b.max_val)) : c.max_val,
        b.activ ? 1 : 0,
        c.id
      )
      .catch(() => null);
    redirect(ctx.res, CALE + inapoi(b.familie_id));
  });

  router.post(`${CALE}/:id/sterge`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    // Nu se sterge daca a nascut deja coduri: atunci doar se dezactiveaza, ca
    // fisa produsului vechi sa poata arata in continuare din ce e facut.
    const folosita = await db
      .prepare("SELECT COUNT(*) AS n FROM produse_cod_valori WHERE caracteristica_id = ?")
      .get(ctx.params.id)
      .catch(() => ({ n: 0 }));
    if (nr(folosita && folosita.n) > 0) {
      await db.prepare("UPDATE cod_caracteristici SET activ = 0 WHERE id = ?").run(ctx.params.id);
    } else {
      await db.prepare("DELETE FROM cod_caracteristici WHERE id = ?").run(ctx.params.id).catch(() => null);
    }
    redirect(ctx.res, CALE + inapoi(ctx.query.familie));
  });

  router.post(`${CALE}/valoare`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const cid = parseInt(b.caracteristica_id, 10) || 0;
    if (!cid) return redirect(ctx.res, CALE);

    // Formularul trimite acum mai multe rânduri. Rămâne și forma cu un singur
    // câmp: o pagină veche lăsată deschisă într-un tab nu trebuie să scrie în
    // tăcere nimic.
    const lista = [];
    const valori = [].concat(b["valoare[]"] === undefined ? (b.valoare === undefined ? [] : [b.valoare]) : b["valoare[]"]);
    const coduri = [].concat(b["cod[]"] === undefined ? (b.cod === undefined ? [] : [b.cod]) : b["cod[]"]);
    // UM-ul e opțional și vine abia de la 03.11.2026 (hârtia: cutie / top).
    // O pagină veche, deschisă de dinainte, nu-l trimite deloc — atunci rămâne
    // gol, nu se mută UM-ul unui rând pe altul.
    const umuri = [].concat(b["um[]"] === undefined ? [] : b["um[]"]);
    for (let i = 0; i < valori.length; i++) {
      const valoare = String(valori[i] || "").trim();
      const cod = C.curat(coduri[i]);
      const um = String(umuri.length === valori.length ? umuri[i] || "" : "").trim().slice(0, 12) || null;
      // Rândul gol de tot se sare fără zgomot: omul a cerut zece rânduri și a
      // completat șapte.
      if (!valoare && !cod) continue;
      lista.push({ valoare, cod, um });
    }
    if (!lista.length) return redirect(ctx.res, CALE + inapoi(b.familie_id));

    const existente = await db.prepare("SELECT valoare, cod FROM cod_valori WHERE caracteristica_id = ?").all(cid);
    const codLuat = new Set(existente.map((v) => C.curat(v.cod)));
    const numeLuat = new Set(existente.map((v) => C.curat(v.valoare)));
    const r = await db.prepare("SELECT COUNT(*) AS n FROM cod_valori WHERE caracteristica_id = ?").get(cid);
    let ordine = nr(r && r.n);

    const sarite = [];
    let scrise = 0;
    for (const v of lista) {
      if (!v.valoare || !v.cod) {
        sarite.push(`rândul „${v.valoare || "(fără valoare)"}" — lipsește ${v.valoare ? "bucata de cod" : "valoarea"}`);
        continue;
      }
      // DOUĂ VALORI CU ACEEAȘI BUCATĂ DE COD = două produse diferite cu
      // același cod. Asta sparge exact lucrul pe care codul unic trebuia
      // să-l apere, și n-ar da nicio eroare mai târziu — doar un stoc rupt
      // în două. Se refuză aici, cu numele rândului scris.
      if (codLuat.has(v.cod)) {
        sarite.push(`„${v.valoare}" — bucata de cod „${v.cod}" e deja folosită la altă valoare`);
        continue;
      }
      if (numeLuat.has(C.curat(v.valoare))) {
        sarite.push(`„${v.valoare}" — există deja`);
        continue;
      }
      await db
        .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine, um) VALUES (?,?,?,?,?)")
        .run(cid, v.valoare, v.cod, ++ordine, v.um);
      codLuat.add(v.cod);
      numeLuat.add(C.curat(v.valoare));
      scrise++;
    }

    if (sarite.length) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user, title: "Valori adăugate", active: CALE,
          body: `<h1>${scrise} ${scrise === 1 ? "valoare scrisă" : "valori scrise"}, ${sarite.length} ${
            sarite.length === 1 ? "sărită" : "sărite"
          }</h1>
            <p style="max-width:640px">Ce n-a intrat, și de ce:</p>
            <ul style="max-width:640px">${sarite.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
            <p style="max-width:640px;color:var(--text-muted);font-size:13px">
              Două valori cu aceeași bucată de cod ar însemna două produse diferite cu același cod — exact
              lucrul pe care codul unic trebuie să-l apere.</p>
            <a class="btn" href="${CALE}${inapoi(b.familie_id)}">Înapoi la configurare</a>`,
        })
      );
    }
    redirect(ctx.res, CALE + inapoi(b.familie_id));
  });

  router.post(`${CALE}/valoare/:id/sterge`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    await db.prepare("DELETE FROM cod_valori WHERE id = ?").run(ctx.params.id).catch(() => null);
    // Înapoi la categoria la care lucra omul, nu la prima din listă.
    redirect(ctx.res, CALE + inapoi((ctx.query && ctx.query.familie) || (ctx.body && ctx.body.familie_id)));
  });

  // Modificarea unei valori: denumirea, bucata de cod, UM-ul. Aceleași reguli
  // ca la adăugare — o bucată de cod e a unei singure valori din listă, iar o
  // valoare nu apare de două ori. Bucata goală rămâne voie doar unde era deja
  // goală („Nepersonalizată" la bandă, vezi lib/cod-familii.js).
  router.post(`${CALE}/valoare/:id/editare`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const inapoiLa = CALE + inapoi(b.familie_id);
    const sep = inapoiLa.includes("?") ? "&" : "?";
    const v = await db.prepare("SELECT * FROM cod_valori WHERE id = ?").get(ctx.params.id);
    if (!v) return redirect(ctx.res, inapoiLa);
    const valoare = String(b.valoare || "").trim();
    const cod = C.curat(b.cod);
    const um = String(b.um || "").trim().slice(0, 12) || null;
    const refuz = (m) => redirect(ctx.res, inapoiLa + sep + "eroare=" + encodeURIComponent(m));
    if (!valoare) return refuz("Valoarea nu poate fi goală.");
    if (!cod && C.curat(v.cod)) return refuz(`„${valoare}”: bucata de cod nu poate rămâne goală — fără ea, codul ar ieși scurt și s-ar putea lovi de altul.`);
    const altele = await db.prepare("SELECT valoare, cod FROM cod_valori WHERE caracteristica_id = ? AND id <> ?").all(v.caracteristica_id, v.id);
    if (cod && altele.some((x) => C.curat(x.cod) === cod)) return refuz(`Bucata de cod „${cod}” e deja la altă valoare din aceeași listă.`);
    if (altele.some((x) => C.curat(x.valoare) === C.curat(valoare))) return refuz(`„${valoare}” există deja în listă.`);
    await db.prepare("UPDATE cod_valori SET valoare = ?, cod = ?, um = ? WHERE id = ?").run(valoare, cod, um, v.id);
    redirect(ctx.res, inapoiLa + sep + "ok=" + encodeURIComponent(`„${valoare}” salvată. Produsele deja făcute își păstrează codul.`));
  });

  // ---- Produs nou, cu cod generat ---------------------------------------
  //
  // Singurul formular din care se face un produs nou. Cererea lui Vali,
  // 04.11.2026: „când adăugăm produs nou, codul produsului trebuie să se
  // autogenereze conform algoritmului din configurări, nu să-l introducem noi,
  // iar câmpurile trebuie să fie și cele din configurare". Butonul „Produs
  // nou" din Produse duce aici (vezi `adaugare` în lib/crud.js), iar
  // formularul are tot ce avea cel vechi, în afară de cod: categorie,
  // gestiune, prețuri, adaos, TVA, stoc minim. Nimic de completat după, din
  // Editare.
  router.get("/produse/nou-cu-cod", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const q = ctx.query || {};
    const mesaj = q.vechi
      ? "Formularul vechi de produs nou nu mai scrie produse: codul se generează acum din caracteristici. " +
        "Ce scriseseși acolo nu s-a salvat — completează aici."
      : "";
    const body = await formularProdusNou({ familieId: Number(q.familie) || 0, mesaj: esc(mesaj) });
    send(ctx.res, 200, layout({ user: ctx.user, title: "Produs nou", active: "/produse", body }));
  });

  // Previzualizarea: aceeasi functie ca la salvare, plus cautarea duplicatului.
  router.post("/produse/nou-cu-cod/preview", async (ctx) => {
    if (!ctx.user) return send(ctx.res, 403, "{}");
    const corp = ctx.body || {};
    const r = await genereaza(corp, Number(corp.__familie) || 0);
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify(r));
  });

  router.post("/produse/nou-cu-cod", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const b = ctx.body || {};
    const alegeri = {};
    for (const k of Object.keys(b)) if (k.startsWith("c_")) alegeri[k.slice(2)] = b[k];
    // Un cod scris de mână nu se citește. Formularul nu-l mai are, dar ce vine
    // prin HTTP nu se crede pe cuvânt: un tab vechi sau un script ar putea
    // trimite `cod`, și atunci produsul ar intra cu un cod care nu iese din
    // caracteristicile lui. Codul e cel generat, punct.
    const familieId = Number(b.familie) || 0;
    const fisa = citesteFisa(b);
    const den = String(b.denumire == null ? "" : b.denumire).trim();
    const r = await genereaza(alegeri, familieId);

    // Ce nu e bun se spune tot o dată, deasupra formularului, care revine cu
    // tot ce a scris omul — nu o pagină de eroare cu „Înapoi" după care
    // prețurile, categoria și gestiunea trebuie tastate din nou.
    const refuza = async (mesaj) =>
      send(
        ctx.res,
        400,
        layout({
          user: ctx.user, title: "Produs nou", active: "/produse",
          body: await formularProdusNou({ familieId, valori: b, mesaj, denAuto: !den || den === r.denumire }),
        })
      );
    const existent = (p) =>
      `Produsul există deja: <a href="/produse/${Number(p.id)}">${esc(p.denumire)}</a>` +
      ` (cod ${esc(p.cod || p.cod_generat || "—")}). Nu l-am mai făcut a doua oară.`;

    const probleme = [];
    if (r.exista) probleme.push(existent(r.exista));
    else if (!r.ok) {
      if (r.lipsa.length) probleme.push(esc("Mai lipsește: " + r.lipsa.join(", ") + "."));
      for (const g of r.gresite) probleme.push(esc(g));
      if (!r.lipsa.length && !r.gresite.length) probleme.push(esc("Din caracteristicile alese nu iese niciun cod."));
    }
    for (const g of fisa.gresite) probleme.push(esc(g));
    if (probleme.length) return refuza(probleme.join("<br>"));

    let scris;
    try {
      scris = await scrieProdusul(r, familieId, {
        ...fisa.valori,
        um: fisa.valori.unitate_masura,
        denumire: den,
        creat_de: ctx.user.id,
      });
    } catch (e) {
      // Două ferestre care salvează același produs în aceeași secundă: a doua
      // se lovește de indexul unic pe codul generat. Omul află care e
      // produsul, nu primește o pagină de eroare a serverului.
      if (e && e.code === "23505") {
        const p = e.exista || (await produsulExistent(r, familieId));
        return refuza(p ? existent(p) : esc("Produsul cu codul " + r.cod + " există deja."));
      }
      throw e;
    }
    redirect(ctx.res, `/produse/${scris.id}`);
  });
}

// Câmpurile fișei de produs, aceleași ca la Editare (modules/produse.js), fără
// cod — care se generează — și fără denumire, care are rândul ei, legat de
// caracteristici. testul test-produs-nou-configurat.js se uită ca fiecare câmp
// scris al fișei să fie și aici: unul adăugat doar acolo ar fi rămas gol la
// fiecare produs nou.
//
// Numerele se scriu în căsuțe de text, nu `type="number"`: un browser în
// engleză nu primește „0,16" într-un câmp numeric și oprește formularul fără
// să spună de ce. Se citesc ca prețurile de pe comandă (lib/pret-camp.js).
const CAMPURI_FISA = [
  { name: "categorie", label: "Categorie", datalist: true, ajutor: "Scrie una nouă sau alege din cele existente." },
  { name: "gestiune", label: "Gestiune", datalist: true, ajutor: "Gestiunea din contabilitate în care stă produsul." },
  { name: "unitate_masura", label: "Unitate de măsură", default: "buc", ajutor: "La hârtie se pune singură: cutie sau top." },
  { name: "pret_achizitie", label: "Preț achiziție", type: "number", default: 0, ajutor: "Pentru marfa pe care o cumpărăm." },
  { name: "pret_productie", label: "Cost de producție", type: "number", ajutor: "Pentru ce facem noi. Lasă gol dacă produsul va avea rețetă — atunci costul se ia din ea." },
  { name: "adaos_lista", label: "Adaos propriu (%)", type: "number", ajutor: "Lasă gol ca să folosească adaosul implicit al firmei." },
  { name: "pret_minim", label: "Preț minim de vânzare", type: "number", ajutor: "Sub prețul ăsta pagina te avertizează. Lasă gol dacă n-ai o limită." },
  { name: "pret_vanzare", label: "Preț vânzare (fără TVA)", type: "number", default: 0, ajutor: "Prețul folosit efectiv în oferte și facturi." },
  { name: "cota_tva", label: "Cotă TVA (%)", type: "number", default: 21 },
  { name: "stoc_minim", label: "Stoc minim (alertă)", type: "number", default: 0 },
];

// Ce a scris omul în câmpurile fișei. Textul, fără spații la capete; un număr
// gol ia valoarea implicită a câmpului, iar unde nu există una rămâne NULL —
// „nu știu costul de producție" e un răspuns valid și nu devine zero. Un
// număr care nu se poate citi oprește salvarea, cu numele câmpului: altfel
// „1.234,50" ar fi intrat ca zero și nimeni n-ar fi văzut până la prima
// factură.
function citesteFisa(b) {
  const valori = {};
  const gresite = [];
  for (const f of CAMPURI_FISA) {
    const brut = b ? b[f.name] : undefined;
    if (f.type === "number") {
      const t = String(brut == null ? "" : brut).replace(/\s+/g, "");
      if (t === "") {
        valori[f.name] = f.default !== undefined ? Number(f.default) : null;
        continue;
      }
      const n = PC.pretDinCamp(t);
      if (!n.ok) {
        gresite.push(`${f.label}: „${String(brut).trim()}" nu e un număr pozitiv (ex. 12,50).`);
        continue;
      }
      valori[f.name] = n.valoare;
    } else {
      const t = String(brut == null ? "" : brut).trim();
      valori[f.name] = t || (f.default !== undefined ? String(f.default) : null);
    }
  }
  return { valori, gresite };
}

// Valorile deja folosite într-o coloană, pentru sugestii. Numele coloanei
// intră în SQL, deci se ia doar din lista de mai sus.
async function valoriFolosite(coloana) {
  if (!CAMPURI_FISA.some((f) => f.datalist && f.name === coloana)) return [];
  const r = await db
    .prepare(`SELECT DISTINCT ${coloana} AS v FROM produse WHERE ${coloana} IS NOT NULL AND ${coloana} <> '' ORDER BY 1`)
    .all()
    .catch(() => []);
  return r.map((x) => String(x.v));
}

// Sugestiile pentru un câmp de text liber: ce s-a mai scris la caracteristica
// asta pe alte produse și, la „Furnizor", furnizorii din Parteneri.
async function sugestiiText(c) {
  const folosite = await db
    .prepare("SELECT DISTINCT valoare AS v FROM produse_cod_valori WHERE caracteristica_id = ? ORDER BY 1 LIMIT 500")
    .all(Number(c.id))
    .catch(() => []);
  const out = new Map();
  for (const x of folosite) if (x.v) out.set(C.litereText(x.v), String(x.v));
  if (/furniz/i.test(String(c.nume || ""))) {
    const fz = await db
      .prepare("SELECT nume AS v FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 2000")
      .all()
      .catch(() => []);
    for (const x of fz) if (x.v && !out.has(C.litereText(x.v))) out.set(C.litereText(x.v), String(x.v));
  }
  return [...out.values()];
}

// Formularul de produs nou: familia, caracteristicile ei, codul care iese și
// fișa produsului. `valori` e ce a trimis omul, când formularul revine după
// un refuz; `mesaj` e HTML gata scăpat.
async function formularProdusNou({ familieId, valori, mesaj, denAuto } = {}) {
  const fam = await familii();
  const fid = fam.some((f) => Number(f.id) === Number(familieId)) ? Number(familieId) : fam[0] ? Number(fam[0].id) : 0;
  const familia = fam.find((f) => Number(f.id) === fid) || null;
  const car = fid ? await citesteCaracteristici(false, fid) : [];
  const v = valori || {};
  const scris = (k) => (v[k] === undefined || v[k] === null ? "" : String(v[k]));
  const gri = (t) => ` <span style="color:var(--text-muted)">${t}</span>`;

  const sugText = {};
  for (const c of car) if (c.fel === "text") sugText[c.id] = await sugestiiText(c);
  const campuri = car
    .map((c) => {
      const et = `${esc(c.nume)}${c.um ? gri("(" + esc(c.um) + ")") : ""}${c.obligatoriu ? "" : gri("(opțional)")}`;
      const ales = scris("c_" + c.id);
      if (c.fel === "text") {
        // Text liber, cu sugestii din ce s-a mai scris: „WBV GmbH" scris o
        // dată așa și o dată „W.B.V." ar face două produse în loc de unul.
        return `<label class="field" style="flex:1 1 240px;max-width:340px"><span>${et}</span>
          <input type="text" name="c_${c.id}" data-carac="${c.id}" value="${esc(ales)}" maxlength="120"
                 list="dl_c_${c.id}" autocomplete="off">
          <datalist id="dl_c_${c.id}">${(sugText[c.id] || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
          <small style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">În cod intră primele ${C.literePentru(c)} litere.</small>
        </label>`;
      }
      if (c.fel === "numar") {
        return `<label class="field" style="flex:0 1 200px"><span>${et}</span>
          <input type="number" step="any" name="c_${c.id}" data-carac="${c.id}" value="${esc(ales)}"
                 ${c.min_val != null ? `min="${nr(c.min_val)}"` : ""} ${c.max_val != null ? `max="${nr(c.max_val)}"` : ""}>
        </label>`;
      }
      return `<label class="field" style="flex:0 1 220px"><span>${et}</span>
        <select name="c_${c.id}" data-carac="${c.id}">
          <option value="">—</option>
          ${(c.valori || [])
            .map((x) => `<option value="${esc(x.valoare)}"${ales !== "" && String(x.valoare) === ales ? " selected" : ""}>${esc(x.valoare)}</option>`)
            .join("")}
        </select>
      </label>`;
    })
    .join("");

  const sugestii = {};
  for (const f of CAMPURI_FISA) if (f.datalist) sugestii[f.name] = await valoriFolosite(f.name);
  const campFisa = (f) => {
    const val = v[f.name] !== undefined && v[f.name] !== null ? String(v[f.name]) : f.default !== undefined ? String(f.default) : "";
    let input;
    if (f.datalist) {
      input = `<input type="text" name="${f.name}" value="${esc(val)}" list="dl_${f.name}" autocomplete="off">
        <datalist id="dl_${f.name}">${(sugestii[f.name] || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;
    } else if (f.type === "number") {
      input = `<input type="text" inputmode="decimal" name="${f.name}" value="${esc(val)}">`;
    } else {
      input = `<input type="text" name="${f.name}" value="${esc(val)}">`;
    }
    const ajutor = f.ajutor ? `<small style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">${esc(f.ajutor)}</small>` : "";
    return `<label class="field" style="flex:1 1 200px;max-width:300px">${esc(f.label)}${input}${ajutor}</label>`;
  };
  const rand = (nume) => `<div style="display:flex;gap:10px;flex-wrap:wrap">${CAMPURI_FISA.filter((f) => nume.includes(f.name)).map(campFisa).join("")}</div>`;

  const fara = !fam.length
    ? `<div class="flash">Nu e definită nicio familie de produse. Începe din <a href="${CALE}">Configurări · Codul produsului</a>.</div>`
    : !car.length
      ? `<div class="flash">Familia asta n-are nicio caracteristică, deci nu iese niciun cod. Începe din <a href="${CALE}${inapoi(fid)}">Configurări · Codul produsului</a>.</div>`
      : "";
  const den = scris("denumire");

  // Titlul „Produs nou" îl pune layout-ul; încă unul aici ar fi apărut de două ori.
  return `
    <p class="explic">
      Alege familia și caracteristicile: codul se generează singur, după regula familiei din
      <a href="${CALE}${inapoi(fid)}">Configurări · Codul produsului</a>, și nu se scrie de mână. Dacă produsul
      există deja, îți spun care e și nu-l mai fac a doua oară. Un fel de produs care nu se potrivește în nicio
      familie se adaugă întâi acolo, ca familie nouă.
    </p>
    ${mesaj ? `<div class="flash flash-rosu">${mesaj}</div>` : ""}
    ${
      fam.length > 1
        ? `<div class="toolbar" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
             <span style="font-size:13px;color:var(--text-muted);align-self:center">Familia:</span>
             ${fam.map((f) => `<a class="btn small ${Number(f.id) === fid ? "" : "secondary"}" href="/produse/nou-cu-cod?familie=${f.id}">${esc(f.nume)}</a>`).join("")}
           </div>`
        : ""
    }
    ${fara}
    <form method="post" action="/produse/nou-cu-cod" class="form" style="max-width:960px" id="f-produs">
      <input type="hidden" name="familie" id="f-familie" value="${fid}">
      <h3 style="margin:8px 0 6px">Caracteristici${familia ? " · " + esc(familia.nume) : ""}</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${campuri}</div>
      <div class="card" style="margin:12px 0;max-width:620px">
        <div class="label">Codul</div>
        <div class="value" id="cod-preview" style="font-family:ui-monospace,monospace">—</div>
        <div class="mic" id="den-preview"></div>
        <div class="mic" id="avertisment" style="color:var(--warn)"></div>
      </div>
      <h3 style="margin:14px 0 6px">Fișa produsului</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <label class="field" style="flex:1 1 420px;max-width:620px">Denumire
          <input type="text" name="denumire" value="${esc(den)}" data-auto="${denAuto === false ? "0" : "1"}" autocomplete="off">
          <small style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">Se scrie din caracteristici. O poți schimba; dacă o golești, rămâne cea din caracteristici.</small>
        </label>
      </div>
      ${rand(["categorie", "gestiune", "unitate_masura"])}
      ${rand(["pret_achizitie", "pret_productie", "adaos_lista"])}
      ${rand(["pret_minim", "pret_vanzare", "cota_tva", "stoc_minim"])}
      <div class="form-actions">
        <button class="btn" type="submit" id="btn-salveaza">Adaugă produsul</button>
        <a href="/produse" class="btn secondary">Renunță</a>
      </div>
    </form>
    <script>
    (function () {
      var f = document.getElementById("f-produs");
      if (!f) return;
      var cod = document.getElementById("cod-preview");
      var den = document.getElementById("den-preview");
      var av = document.getElementById("avertisment");
      var btn = document.getElementById("btn-salveaza");
      var denIn = f.querySelector('input[name="denumire"]');
      var umIn = f.querySelector('input[name="unitate_masura"]');
      var ceas = null;
      var ultima = 0;
      // Denumirea urmează caracteristicile până când omul scrie el ceva în
      // ea. Golită, se întoarce la cea din caracteristici.
      if (denIn) denIn.addEventListener("input", function () { denIn.dataset.auto = denIn.value.trim() ? "0" : "1"; });
      // Previzualizarea cere serverului sa genereze codul. Nu rescriem
      // regula si in browser: doua implementari ale aceleiasi reguli o iau
      // razna separat, si atunci ecranul arata un cod, iar baza scrie altul.
      function cere() {
        var nr = ++ultima;
        var d = {};
        f.querySelectorAll("[data-carac]").forEach(function (el) {
          if (el.value !== "") d[el.dataset.carac] = el.value;
        });
        d.__familie = document.getElementById("f-familie").value;
        fetch("/produse/nou-cu-cod/preview", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        })
          .then(function (r) { return r.json(); })
          .then(function (x) {
            // Răspunsurile pot veni în altă ordine decât cererile. Unul vechi,
            // sosit după cel nou, ar fi pus pe ecran codul de dinainte și ar fi
            // pornit butonul pentru alegeri care nu mai sunt cele din formular.
            if (nr !== ultima) return;
            cod.textContent = x.cod || "—";
            den.textContent = x.denumire || "";
            if (denIn) {
              denIn.placeholder = x.denumire || "";
              if (denIn.dataset.auto !== "0") denIn.value = x.denumire || "";
            }
            var m = [];
            if (x.lipsa && x.lipsa.length) m.push("mai lipsește: " + x.lipsa.join(", "));
            if (x.gresite && x.gresite.length) m.push(x.gresite.join("; "));
            if (x.exista) m.push("EXISTĂ DEJA: " + x.exista.denumire + " (id " + x.exista.id + ")");
            if (x.ambiguu) m.push("numerele n-au lungime fixă — codul se poate lovi de altul");
            av.textContent = m.join(" · ");
            if (x.exista) {
              var a = document.createElement("a");
              a.href = "/produse/" + Number(x.exista.id);
              a.textContent = "deschide-l";
              av.appendChild(document.createTextNode(" · "));
              av.appendChild(a);
            }
            // Unitatea dată de caracteristici (hârtia: cutie / top) se vede
            // în căsuță și nu se poate schimba — oricum la salvare câștigă ea.
            if (umIn) {
              if (x.um) { umIn.value = x.um; umIn.readOnly = true; umIn.title = "Vine din caracteristicile alese"; }
              else if (umIn.readOnly) { umIn.readOnly = false; umIn.value = "buc"; umIn.title = ""; }
            }
            btn.disabled = !x.ok || !!x.exista;
          })
          .catch(function () {});
      }
      // Doar caracteristicile schimbă codul; prețurile și categoria nu cer
      // o previzualizare nouă la fiecare tastă.
      function peCaracteristica(e) { return !!(e.target && e.target.dataset && e.target.dataset.carac); }
      f.addEventListener("input", function (e) {
        if (!peCaracteristica(e)) return;
        clearTimeout(ceas);
        ceas = setTimeout(cere, 180);
      });
      f.addEventListener("change", function (e) { if (peCaracteristica(e)) cere(); });
      // Un dublu-clic nu face două cereri de salvare.
      f.addEventListener("submit", function () { setTimeout(function () { btn.disabled = true; }, 0); });
      cere();
    })();
    </script>
  `;
}

// Scrierea produsului dintr-un rezultat deja generat.
//
// Stă separat fiindcă îl cheamă două ecrane: „Produs nou" din nomenclator și
// comanda agentului. Dacă fiecare ar scrie cu INSERT-ul lui, unul dintre ele
// ar uita mai devreme sau mai târziu `cod_generat` sau caracteristicile, iar
// produsul ar intra în sistem fără codul după care îl caută toată lumea.
//
// `extra` e fișa produsului: { um, denumire, categorie, gestiune,
// pret_achizitie, pret_productie, adaos_lista, pret_minim, pret_vanzare (sau
// `pret`, cum îl dădea formularul vechi), cota_tva, stoc_minim, creat_de }.
// Comanda dă doar `um`; restul iau valorile cu care intra și până acum un
// produs nou: prețuri zero, TVA 21%, costurile și adaosul necunoscute (NULL).
async function scrieProdusul(r, familieId, extra = {}) {
  const e = extra || {};
  // Unitatea dată de o valoare aleasă bate ce scrie în căsuță. La hârtie,
  // căsuța pornește cu „buc", iar o cutie scrisă „buc" ar arăta pe factură ca
  // o bucată, nu ca cinci topuri. Unde nicio valoare nu dă unitate (toate
  // celelalte familii), rămâne ce a scris omul.
  const unitate = String((r && r.um) || e.um || "buc").trim() || "buc";
  // Denumirea scrisă de om, dacă a scris una; altfel cea din caracteristici.
  const denumire = String(e.denumire == null ? "" : e.denumire).trim() || r.denumire;
  const numar = (v) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const x = Number(String(v).replace(",", "."));
    return Number.isFinite(x) ? x : null;
  };
  const text = (v) => String(v == null ? "" : v).trim() || null;
  const tva = numar(e.cota_tva);
  const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
  // Primele șapte coloane stau în aceeași ordine ca înainte; cele noi vin
  // după ele.
  const scrie = () =>
    db
      .prepare(
        `INSERT INTO produse (cod, cod_generat, denumire, unitate_masura, pret_vanzare, stoc_minim, cod_familie_id,
                              categorie, gestiune, pret_achizitie, pret_productie, adaos_lista, pret_minim, cota_tva,
                              creat_de, creat_la, cod_semnatura)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
      )
      .run(
        r.cod, r.cod, denumire, unitate,
        numar(e.pret_vanzare !== undefined ? e.pret_vanzare : e.pret) || 0,
        numar(e.stoc_minim) || 0,
        familieId || null,
        text(e.categorie), text(e.gestiune),
        numar(e.pret_achizitie) || 0,
        numar(e.pret_productie), numar(e.adaos_lista), numar(e.pret_minim),
        tva === null ? 21 : tva,
        Number(e.creat_de) || null, acum,
        r.contor ? r.semnatura : null
      );
  // La textul liber, numărul de ordine se ia din nou chiar înainte de scriere:
  // cel din previzualizare poate fi fost luat între timp. Dacă tot se lovește
  // (două ferestre în aceeași clipă), se mai încearcă de câteva ori; dacă s-a
  // lovit de semnătură, produsul există deja și nu se mai scrie.
  if (r.contor) r.cod = await urmatorulCod(r.prefix);
  let ins = null;
  for (let incercare = 0; !ins; incercare++) {
    try {
      ins = await scrie();
    } catch (err) {
      if (!r.contor || !err || err.code !== "23505" || incercare >= 4) throw err;
      const deja = await produsulSemnaturii(familieId, r.semnatura);
      if (deja) {
        const e2 = new Error("Produsul există deja");
        e2.code = "23505";
        e2.exista = deja;
        throw e2;
      }
      r.cod = await urmatorulCod(r.prefix);
    }
  }
  const id = Number(ins.lastInsertRowid);
  for (const buc of r.bucati_toate) {
    await db
      .prepare("INSERT INTO produse_cod_valori (produs_id, caracteristica_id, nume, valoare, bucata) VALUES (?,?,?,?,?)")
      .run(id, buc.id, buc.nume, buc.valoare, buc.cod || null);
  }
  return { id, cod: r.cod, denumire };
}

// Produsul pentru un set de caracteristici: îl găsește dacă există, îl scrie
// dacă nu.
//
// Două comenzi cu aceleași caracteristici trebuie să ajungă pe ACELAȘI produs,
// altfel stocul se rupe în două și nimeni nu mai știe câte pungi de 350×450
// avem. De-aia căutarea duplicatului (din `genereaza`) și scrierea stau
// lipite aici, nu lăsate pe seama fiecărui ecran în parte.
async function produsulAlegerilor(alegeri, familieId, extra = {}) {
  const r = await genereaza(alegeri, familieId);
  // Un produs pe jumătate configurat n-are voie să intre în nomenclator: ar
  // rămâne acolo cu un cod scurt care se lovește de al altuia.
  //
  // Și nici să cadă pe unul existent: banda fără „Personalizare" aleasă dă
  // codul benzii simple (vezi sePoateComanda din lib/comanda-config.js), deci
  // verificarea de complet vine ÎNAINTEA căutării, nu după.
  if (!r.ok) return { r, id: null, creat: false };
  if (r.exista) return { r, id: Number(r.exista.id), creat: false };
  try {
    const scris = await scrieProdusul(r, familieId, extra);
    return { r, id: scris.id, creat: true };
  } catch (e) {
    // Două comenzi care scriu în aceeași clipă același produs nou: a doua cade
    // pe produsul primei, exact ca și cum ar fi venit o secundă mai târziu.
    if (e && e.code === "23505") {
      const p = e.exista || (await produsulExistent(r, familieId));
      if (p) return { r: { ...r, exista: p }, id: Number(p.id), creat: false };
    }
    throw e;
  }
}

// Produsul care are deja codul ăsta — generat din caracteristici sau scris de
// om. Un produs înghițit la Unificarea codurilor își ține codul generat (e unic
// în bază), dar comanda trebuie să cadă pe produsul PĂSTRAT, nu pe unul
// dezactivat. Codul scris de om se compară fără spații la capete.
async function produsulCodului(cod) {
  const c = String(cod || "").trim().toUpperCase();
  if (!c) return null;
  return db
    .prepare(
      `SELECT p.id, p.denumire, p.cod, p.cod_generat FROM produse p
        WHERE p.id = (SELECT COALESCE(x.fuzionat_in, x.id) FROM produse x
                       WHERE x.cod_generat = ? OR UPPER(TRIM(COALESCE(x.cod, ''))) = ?
                       ORDER BY (x.fuzionat_in IS NULL) DESC, x.id LIMIT 1)`
    )
    .get(c, c)
    .catch(() => null);
}

// Produsul unei categorii cu text liber, după tot ce s-a scris pe el. Ca la
// `produsulCodului`, un produs înghițit la Unificarea codurilor trimite la cel
// păstrat.
async function produsulSemnaturii(familieId, semnatura) {
  if (!semnatura) return null;
  return db
    .prepare(
      `SELECT p.id, p.denumire, p.cod, p.cod_generat FROM produse p
        WHERE p.id = (SELECT COALESCE(x.fuzionat_in, x.id) FROM produse x
                       WHERE x.cod_familie_id = ? AND x.cod_semnatura = ?
                       ORDER BY (x.fuzionat_in IS NULL) DESC, x.id LIMIT 1)`
    )
    .get(Number(familieId) || 0, String(semnatura))
    .catch(() => null);
}

// Primul cod liber pentru un început: prefixul + cel mai mare număr de ordine
// găsit + 1. Se uită și la codurile scrise de mână (`cod`), nu doar la cele
// generate: un produs vechi care se cheamă deja WBVFOL01 nu trebuie lovit.
async function urmatorulCod(prefix) {
  const p = C.curat(prefix);
  if (!p) return "";
  const luate = (
    await db
      .prepare(
        `SELECT cod_generat AS c FROM produse WHERE cod_generat LIKE ?
         UNION SELECT UPPER(TRIM(cod)) AS c FROM produse WHERE UPPER(TRIM(COALESCE(cod, ''))) LIKE ?`
      )
      .all(p + "%", p + "%")
      .catch(() => [])
  ).map((x) => x.c);
  return C.codCuContor(p, luate);
}

// Produsul care a apărut între previzualizare și salvare: după semnătură la
// textul liber, după cod în rest. La textul liber NU se caută și după cod:
// codul lovit poate fi al altui produs cu aceleași litere (WBVFOL02 luat de
// „WBV Pack · Folie PE"), iar comanda ar fi căzut pe produsul greșit.
async function produsulExistent(r, familieId) {
  if (r && r.contor) return produsulSemnaturii(familieId, r.semnatura);
  return r && r.cod ? produsulCodului(r.cod) : null;
}

// Generarea + verificarea duplicatului. Un singur loc, folosit si de
// previzualizare, si de salvare — altfel ecranul ar putea spune „liber" iar
// salvarea „exista deja", sau invers.
//
// La o categorie cu text liber (furnizor, denumire), primele litere nu spun
// care e produsul: „WBV GmbH · Folie aluminiu" și „WBV Pack · Folie PE" dau
// amândouă WBVFOL. Acolo produsul existent se caută după tot ce s-a scris
// (semnătura), iar codul unui produs nou primește primul număr de ordine
// liber: WBVFOL01, WBVFOL02… Numărul arătat în previzualizare e cel de acum;
// la salvare se ia din nou, ca să nu-l prindă două ferestre deodată.
async function genereaza(alegeri, familieId) {
  const car = await citesteCaracteristici(false, familieId);
  const r = C.genereazaCod(car, alegeri || {});
  let exista = null;
  if (r.contor) {
    if (r.ok) {
      exista = await produsulSemnaturii(familieId, r.semnatura);
      r.cod = exista ? String(exista.cod_generat || exista.cod || "") : await urmatorulCod(r.prefix);
    }
  } else {
    exista = r.cod ? await produsulCodului(r.cod) : null;
  }
  // Toate caracteristicile completate, nu doar cele din cod: pe fisa
  // produsului vrem sa se vada si cele care nu intra in cod.
  const bucatiToate = [];
  for (const c of car) {
    const v = alegeri ? alegeri[c.id] : undefined;
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const inCod = r.bucati.find((b) => b.caracteristica === c.nume);
    bucatiToate.push({ id: c.id, nume: c.nume, valoare: c.fel === "text" ? C.textCurat(v) : String(v), cod: inCod ? inCod.cod : null });
  }
  return { ...r, exista: exista || null, bucati_toate: bucatiToate };
}

module.exports = {
  register,
  seed,
  citesteCaracteristici,
  familii,
  genereaza,
  produsulCodului,
  produsulSemnaturii,
  urmatorulCod,
  sugestiiText,
  produsulAlegerilor,
  scrieProdusul,
  CALE,
};
