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

// Caracteristicile cu valorile lor, gata de dat la lib/cod-produs.
async function citesteCaracteristici(totul) {
  const car = await db
    .prepare(`SELECT * FROM cod_caracteristici ${totul ? "" : "WHERE activ = 1"} ORDER BY ordine, id`)
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

// Prima deschidere: punem exact caracteristicile cerute de Vali pe 26.10.2026,
// ca pagina sa nu fie goala si sa se vada din ce se compune un cod. Se pun o
// singura data; daca el le schimba sau le sterge, nu se mai intorc.
async function seed() {
  const are = await db.prepare("SELECT COUNT(*) AS n FROM cod_caracteristici").get().catch(() => null);
  if (!are || nr(are.n) > 0) return;
  const start = [
    { nume: "Tip", fel: "lista", ordine: 1, valori: [["Folie Stretch", "FS"], ["Folie Prestretch", "FP"]] },
    { nume: "Aplicare", fel: "lista", ordine: 2, valori: [["Manuală", "M"], ["Automată", "A"]] },
    { nume: "Culoare", fel: "lista", ordine: 3, valori: [["Transparent", "T"], ["Alb", "A"], ["Negru", "N"]] },
    { nume: "Grosime", fel: "numar", um: "microni", ordine: 4, cifre: 2, min_val: 4, max_val: 23 },
    { nume: "Lungime", fel: "numar", um: "m", ordine: 5, cifre: 3 },
  ];
  for (const c of start) {
    const r = await db
      .prepare(
        `INSERT INTO cod_caracteristici (nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
         VALUES (?,?,?,1,?,1,?,?,?) RETURNING id`
      )
      .run(c.nume, c.fel, c.um || null, c.ordine, c.cifre || 0, c.min_val ?? null, c.max_val ?? null);
    const id = Number(r.lastInsertRowid);
    let o = 0;
    for (const [valoare, cod] of c.valori || []) {
      await db.prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine) VALUES (?,?,?,?)").run(id, valoare, cod, ++o);
    }
  }
  console.log("[cod-produs] caracteristicile de pornire au fost puse");
}

function register(router) {
  // ---- Configurare -------------------------------------------------------
  router.get(CALE, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const car = await citesteCaracteristici(true);
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
        Codul unui produs se scrie singur, din caracteristicile de mai jos. Tu alegi care caracteristici intră
        în cod și în ce ordine; restul rămân doar în denumire. La produs nou, sistemul verifică dacă mai
        există deja un produs cu codul ieșit — și te oprește dacă da.
      </p>
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

  router.post(`${CALE}/caracteristica`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, CALE);
    const fel = b.fel === "numar" ? "numar" : "lista";
    await db
      .prepare(
        `INSERT INTO cod_caracteristici (nume, fel, um, in_cod, ordine, obligatoriu, cifre, min_val, max_val)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
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
    redirect(ctx.res, CALE);
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
    redirect(ctx.res, CALE);
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
    redirect(ctx.res, CALE);
  });

  router.post(`${CALE}/valoare/:id/sterge`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    await db.prepare("DELETE FROM cod_valori WHERE id = ?").run(ctx.params.id).catch(() => null);
    redirect(ctx.res, CALE);
  });

  // ---- Produs nou, cu cod generat ---------------------------------------
  router.get("/produse/nou-cu-cod", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const car = await citesteCaracteristici();
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
      ${car.length ? "" : `<div class="flash">Nu e definită nicio caracteristică. Începe din <a href="${CALE}">Configurări · Codul produsului</a>.</div>`}
      <form method="post" action="/produse/nou-cu-cod" class="form" style="max-width:860px" id="f-produs">
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
    const r = await genereaza(ctx.body || {});
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify(r));
  });

  router.post("/produse/nou-cu-cod", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const b = ctx.body || {};
    const alegeri = {};
    for (const k of Object.keys(b)) if (k.startsWith("c_")) alegeri[k.slice(2)] = b[k];
    const r = await genereaza(alegeri);
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
        `INSERT INTO produse (cod, cod_generat, denumire, unitate_masura, pret_vanzare, stoc_minim)
         VALUES (?,?,?,?,?,?) RETURNING id`
      )
      .run(r.cod, r.cod, r.denumire, String(b.unitate_masura || "buc"), Number(b.pret_vanzare) || 0, Number(b.stoc_minim) || 0);
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
async function genereaza(alegeri) {
  const car = await citesteCaracteristici();
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
