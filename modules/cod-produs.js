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

const CALE = "/configurari/cod-produs";
const nr = (v) => {
  const x = Number(v);
  return isFinite(x) ? x : 0;
};
// Dupa o salvare ne intoarcem la familia la care lucra omul, nu la prima din
// lista. Altfel, cine adauga sase valori la „Pungă curier" ajunge de sase ori
// inapoi la folia stretch.
const inapoi = (f) => (Number(f) ? "?familie=" + Number(f) : "");

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
      for (const [valoare, cod] of valori || []) {
        await db
          .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine) VALUES (?,?,?,?)")
          .run(Number(r.lastInsertRowid), valoare, cod, ++k);
      }
    }
  }
  console.log("[cod-produs] " + START.length + " familii de produse au fost puse");
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
      c.fel === "numar" ? `număr${c.um ? " (" + esc(c.um) + ")" : ""}` : "listă",
      c.fel === "numar"
        ? `${c.min_val != null ? nr(c.min_val) : "—"} … ${c.max_val != null ? nr(c.max_val) : "—"}`
        : (c.valori || []).map((v) => `<code>${esc(v.cod)}</code> ${esc(v.valoare)}`).join("<br>") || "—",
      c.in_cod ? '<span class="badge verde">în cod</span>' : '<span class="badge">doar în denumire</span>',
      nr(c.ordine),
      c.fel === "numar" ? (nr(c.cifre) ? nr(c.cifre) + " cifre" : '<span class="badge rosu">lungime liberă</span>') : "—",
      c.obligatoriu ? "da" : "nu",
      `<form method="post" action="${CALE}/${c.id}/sterge" class="inline-form"
             onsubmit="return confirm('Ștergi caracteristica „${esc(c.nume)}”? Codurile deja generate rămân cum sunt.')">
         <button class="link-btn danger" type="submit">Șterge</button>
       </form>`,
    ]);

    const body = `
      ${subnav(CALE)}
      <h1 style="margin:6px 0 2px">Codul produsului</h1>
      <p class="explic">
        Codul unui produs se scrie singur, din caracteristicile familiei lui. Tu alegi care caracteristici intră
        în cod și în ce ordine; restul rămân doar în denumire. La produs nou, sistemul verifică dacă mai
        există deja un produs cu codul ieșit — și te oprește dacă da.
      </p>

      <div class="toolbar" style="flex-wrap:wrap;gap:6px">
        ${fam
          .map((f) => `<a class="btn ${Number(f.id) === familieId ? "" : "secondary"}" href="${CALE}?familie=${f.id}">${esc(f.nume)}</a>`)
          .join("")}
        ${fam.length ? "" : '<span style="color:var(--text-muted)">Nicio familie încă.</span>'}
      </div>
      ${
        ctx.user.rol === "admin"
          ? `<details style="margin:6px 0 14px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Familie nouă / șterge familia</summary>
               <form method="post" action="${CALE}/familie" class="form" style="max-width:720px;margin-top:10px">
                 <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
                   <label class="field" style="flex:1 1 220px">Denumirea familiei<input name="nume" required placeholder="Pungă curier"></label>
                   <label class="field" style="flex:0 1 120px">Ordine<input type="number" name="ordine" value="${fam.length + 1}"></label>
                   <button class="btn small" type="submit">Adaugă familia</button>
                 </div>
                 <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">
                   O familie e un fel de produs cu atributele lui: punga curier are clapetă, banda adezivă are
                   zgomot. Fiecare își ține caracteristicile separat, deci „Culoare" poate exista la toate, cu
                   alte valori.
                 </p>
               </form>
               ${
                 familia
                   ? `<form method="post" action="${CALE}/familie/${familia.id}/sterge" class="inline-form" style="margin-top:8px"
                            onsubmit="return confirm('Ștergi familia „${esc(familia.nume)}” cu tot cu caracteristicile ei? Produsele deja făcute rămân cum sunt.')">
                        <button class="link-btn danger" type="submit">Șterge familia „${esc(familia.nume)}"</button>
                      </form>`
                   : ""
               }
             </details>`
          : ""
      }
      ${fam.length ? `<h2 style="margin:4px 0 2px">${esc(familia ? familia.nume : "—")}</h2>` : ""}
      ${
        sab.length
          ? `<div class="card" style="max-width:720px;margin-bottom:16px">
               <div class="label">Cum arată codul acum</div>
               <div class="value" style="font-family:ui-monospace,monospace">${esc(exemplu || "—")}</div>
               <div class="mic">${sab.map((s) => esc(s.nume)).join(" + ")}</div>
             </div>`
          : ""
      }
      ${table(["Caracteristică", "Fel", "Valori / interval", "În cod", "Ordine", "Cifre", "Obligatorie", ""], randuri)}

      <h2>Adaugă o caracteristică</h2>
      <form method="post" action="${CALE}/caracteristica" class="form" style="max-width:720px">
        <input type="hidden" name="familie_id" value="${familieId}">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:1 1 200px">Denumire<input name="nume" required placeholder="Culoare"></label>
          <label class="field" style="flex:0 1 150px">Fel
            <select name="fel"><option value="lista">listă de valori</option><option value="numar">număr</option></select>
          </label>
          <label class="field" style="flex:0 1 120px">Unitate<input name="um" placeholder="microni"></label>
          <label class="field" style="flex:0 1 100px">Ordine<input type="number" name="ordine" value="${car.length + 1}"></label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:0 1 110px">Minim<input type="number" step="any" name="min_val"></label>
          <label class="field" style="flex:0 1 110px">Maxim<input type="number" step="any" name="max_val"></label>
          <label class="field" style="flex:0 1 150px">Cifre în cod<input type="number" name="cifre" value="0"></label>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px">
          „Cifre în cod" contează doar la numere, și contează mult: fără lungime fixă, grosime 1 cu lungime 200
          și grosime 12 cu lungime 0 dau amândouă <code>1200</code> — două produse diferite, același cod.
        </p>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="in_cod" value="1" checked> intră în cod</label>
        <label style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" name="obligatoriu" value="1" checked> obligatorie</label>
        <button class="btn" type="submit">Adaugă caracteristica</button>
      </form>

      ${
        car.filter((c) => c.fel === "lista").length
          ? `<h2>Adaugă o valoare</h2>
             <form method="post" action="${CALE}/valoare" class="form" style="max-width:720px">
               <input type="hidden" name="familie_id" value="${familieId}">
               <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
                 <label class="field" style="flex:0 1 200px">Caracteristica
                   <select name="caracteristica_id" required>
                     ${car.filter((c) => c.fel === "lista").map((c) => `<option value="${c.id}">${esc(c.nume)}</option>`).join("")}
                   </select>
                 </label>
                 <label class="field" style="flex:1 1 200px">Valoarea<input name="valoare" required placeholder="Verde"></label>
                 <label class="field" style="flex:0 1 140px">Bucata de cod<input name="cod" required placeholder="V"></label>
                 <button class="btn" type="submit">Adaugă valoarea</button>
               </div>
             </form>
             ${table(
               ["Caracteristică", "Valoare", "Cod", ""],
               car
                 .filter((c) => c.fel === "lista")
                 .flatMap((c) =>
                   (c.valori || []).map((v) => [
                     esc(c.nume),
                     esc(v.valoare),
                     `<code>${esc(v.cod)}</code>`,
                     `<form method="post" action="${CALE}/valoare/${v.id}/sterge" class="inline-form">
                        <button class="link-btn danger" type="submit">Șterge</button></form>`,
                   ])
                 )
             )}`
          : ""
      }
      <p style="margin-top:18px"><a class="btn secondary" href="/produse/nou-cu-cod">Produs nou, cu cod generat →</a></p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Codul produsului", active: "/configurari", body }));
  });

  router.post(`${CALE}/familie`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, CALE);
    const r = await db
      .prepare("INSERT INTO cod_familii (nume, ordine) VALUES (?, ?) RETURNING id")
      .run(nume, parseInt(b.ordine, 10) || 0)
      .catch(() => null);
    redirect(ctx.res, CALE + inapoi(r && r.lastInsertRowid));
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
      await db.prepare("DELETE FROM cod_caracteristici WHERE familie_id = ?").run(id).catch(() => null);
      await db.prepare("DELETE FROM cod_familii WHERE id = ?").run(id).catch(() => null);
    }
    redirect(ctx.res, CALE);
  });

  router.post(`${CALE}/caracteristica`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, CALE);
    const fel = b.fel === "numar" ? "numar" : "lista";
    await db
      .prepare(
        `INSERT INTO cod_caracteristici (familie_id, nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        parseInt(b.familie_id, 10) || null,
        nume,
        fel,
        String(b.um || "").trim() || null,
        b.in_cod ? 1 : 0,
        parseInt(b.ordine, 10) || 0,
        b.obligatoriu ? 1 : 0,
        parseInt(b.cifre, 10) || 0,
        b.min_val === "" || b.min_val == null ? null : Number(b.min_val),
        b.max_val === "" || b.max_val == null ? null : Number(b.max_val)
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
    const valoare = String(b.valoare || "").trim();
    const cod = C.curat(b.cod);
    if (!cid || !valoare || !cod) return redirect(ctx.res, CALE);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM cod_valori WHERE caracteristica_id = ?").get(cid);
    await db
      .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine) VALUES (?,?,?,?)")
      .run(cid, valoare, cod, nr(n && n.n) + 1);
    redirect(ctx.res, CALE + inapoi(b.familie_id));
  });

  router.post(`${CALE}/valoare/:id/sterge`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    await db.prepare("DELETE FROM cod_valori WHERE id = ?").run(ctx.params.id).catch(() => null);
    redirect(ctx.res, CALE);
  });

  // ---- Produs nou, cu cod generat ---------------------------------------
  router.get("/produse/nou-cu-cod", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const fam = await familii();
    const familieId = Number(ctx.query.familie) || (fam[0] ? Number(fam[0].id) : 0);
    const car = await citesteCaracteristici(false, familieId);
    const campuri = car
      .map((c) => {
        const et = `${esc(c.nume)}${c.um ? ` <span style="color:var(--text-muted)">(${esc(c.um)})</span>` : ""}${
          c.obligatoriu ? "" : " <span style=\"color:var(--text-muted)\">(opțional)</span>"
        }`;
        if (c.fel === "numar") {
          return `<label class="field" style="flex:0 1 200px">${et}
            <input type="number" step="any" name="c_${c.id}" data-carac="${c.id}"
                   ${c.min_val != null ? `min="${nr(c.min_val)}"` : ""} ${c.max_val != null ? `max="${nr(c.max_val)}"` : ""}>
          </label>`;
        }
        return `<label class="field" style="flex:0 1 220px">${et}
          <select name="c_${c.id}" data-carac="${c.id}">
            <option value="">—</option>
            ${(c.valori || []).map((v) => `<option value="${esc(v.valoare)}">${esc(v.valoare)}</option>`).join("")}
          </select>
        </label>`;
      })
      .join("");

    const body = `
      <h1 style="margin:6px 0 2px">Produs nou</h1>
      <p class="explic">
        Alege caracteristicile; codul și denumirea se scriu singure. Dacă produsul există deja, îți spun care e
        și nu-l mai fac a doua oară. Caracteristicile se definesc în
        <a href="${CALE}">Configurări · Codul produsului</a>.
      </p>
      ${
        fam.length > 1
          ? `<div class="toolbar" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
               <span style="font-size:13px;color:var(--text-muted);align-self:center">Familia:</span>
               ${fam.map((f) => `<a class="btn small ${Number(f.id) === familieId ? "" : "secondary"}" href="/produse/nou-cu-cod?familie=${f.id}">${esc(f.nume)}</a>`).join("")}
             </div>`
          : ""
      }
      ${car.length ? "" : `<div class="flash">Familia asta n-are nicio caracteristică. Începe din <a href="${CALE}">Configurări · Codul produsului</a>.</div>`}
      <form method="post" action="/produse/nou-cu-cod" class="form" style="max-width:860px" id="f-produs">
        <input type="hidden" name="familie" id="f-familie" value="${familieId}">
        <div style="display:flex;gap:10px;flex-wrap:wrap">${campuri}</div>
        <div class="card" style="margin:12px 0;max-width:620px">
          <div class="label">Codul</div>
          <div class="value" id="cod-preview" style="font-family:ui-monospace,monospace">—</div>
          <div class="mic" id="den-preview"></div>
          <div class="mic" id="avertisment" style="color:var(--warn)"></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:0 1 160px">UM<input name="unitate_masura" value="buc"></label>
          <label class="field" style="flex:0 1 160px">Preț vânzare<input type="number" step="0.0001" name="pret_vanzare" value="0"></label>
          <label class="field" style="flex:0 1 160px">Stoc minim<input type="number" step="any" name="stoc_minim" value="0"></label>
        </div>
        <button class="btn" type="submit" id="btn-salveaza">Adaugă produsul</button>
      </form>
      <script>
      (function () {
        var f = document.getElementById("f-produs");
        if (!f) return;
        var cod = document.getElementById("cod-preview");
        var den = document.getElementById("den-preview");
        var av = document.getElementById("avertisment");
        var ceas = null;
        // Previzualizarea cere serverului sa genereze codul. Nu rescriem
        // regula si in browser: doua implementari ale aceleiasi reguli o iau
        // razna separat, si atunci ecranul arata un cod, iar baza scrie altul.
        function cere() {
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
              cod.textContent = x.cod || "—";
              den.textContent = x.denumire || "";
              var m = [];
              if (x.lipsa && x.lipsa.length) m.push("mai lipsește: " + x.lipsa.join(", "));
              if (x.gresite && x.gresite.length) m.push(x.gresite.join("; "));
              if (x.exista) m.push("EXISTĂ DEJA: " + x.exista.denumire + " (id " + x.exista.id + ")");
              if (x.ambiguu) m.push("numerele n-au lungime fixă — codul se poate lovi de altul");
              av.textContent = m.join(" · ");
              document.getElementById("btn-salveaza").disabled = !x.ok || !!x.exista;
            })
            .catch(function () {});
        }
        f.addEventListener("input", function () { clearTimeout(ceas); ceas = setTimeout(cere, 180); });
        f.addEventListener("change", cere);
        cere();
      })();
      </script>
    `;
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
    const familieId = Number(b.familie) || 0;
    const r = await genereaza(alegeri, familieId);
    if (!r.ok || r.exista) {
      const motiv = r.exista
        ? `Produsul există deja: ${r.exista.denumire} (cod ${r.exista.cod_generat || r.exista.cod || "—"}).`
        : [...(r.lipsa.length ? ["mai lipsește: " + r.lipsa.join(", ")] : []), ...r.gresite].join("; ");
      return send(
        ctx.res,
        400,
        layout({
          user: ctx.user, title: "Produs nou", active: "/produse",
          body: `<h1>Produsul nu s-a scris</h1><p>${esc(motiv)}</p>
                 <p><a class="btn secondary" href="/produse/nou-cu-cod">Înapoi</a></p>`,
        })
      );
    }
    const ins = await db
      .prepare(
        `INSERT INTO produse (cod, cod_generat, denumire, unitate_masura, pret_vanzare, stoc_minim, cod_familie_id)
         VALUES (?,?,?,?,?,?,?) RETURNING id`
      )
      .run(r.cod, r.cod, r.denumire, String(b.unitate_masura || "buc"), Number(b.pret_vanzare) || 0, Number(b.stoc_minim) || 0, familieId || null);
    const id = Number(ins.lastInsertRowid);
    for (const buc of r.bucati_toate) {
      await db
        .prepare("INSERT INTO produse_cod_valori (produs_id, caracteristica_id, nume, valoare, bucata) VALUES (?,?,?,?,?)")
        .run(id, buc.id, buc.nume, buc.valoare, buc.cod || null);
    }
    redirect(ctx.res, `/produse/${id}`);
  });
}

// Generarea + verificarea duplicatului. Un singur loc, folosit si de
// previzualizare, si de salvare — altfel ecranul ar putea spune „liber" iar
// salvarea „exista deja", sau invers.
async function genereaza(alegeri, familieId) {
  const car = await citesteCaracteristici(false, familieId);
  const r = C.genereazaCod(car, alegeri || {});
  let exista = null;
  if (r.cod) {
    exista = await db
      .prepare("SELECT id, denumire, cod, cod_generat FROM produse WHERE cod_generat = ? OR UPPER(COALESCE(cod,'')) = ? LIMIT 1")
      .get(r.cod, r.cod)
      .catch(() => null);
  }
  // Toate caracteristicile completate, nu doar cele din cod: pe fisa
  // produsului vrem sa se vada si cele care nu intra in cod.
  const bucatiToate = [];
  for (const c of car) {
    const v = alegeri ? alegeri[c.id] : undefined;
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const inCod = r.bucati.find((b) => b.caracteristica === c.nume);
    bucatiToate.push({ id: c.id, nume: c.nume, valoare: String(v), cod: inCod ? inCod.cod : null });
  }
  return { ...r, exista: exista || null, bucati_toate: bucatiToate };
}

module.exports = { register, seed, citesteCaracteristici, genereaza, CALE };
