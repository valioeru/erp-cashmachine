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
               : ""
           }
           <label class="bif"><input type="checkbox" name="in_cod" value="1"${c.in_cod ? " checked" : ""}> intră în cod</label>
           <label class="bif"><input type="checkbox" name="obligatoriu" value="1"${c.obligatoriu ? " checked" : ""}> obligatorie</label>
           <label class="bif"><input type="checkbox" name="activ" value="1"${c.activ ? " checked" : ""}> activă</label>
           <button class="btn small" type="submit">Salvează</button>
         </form>
       </details>
       <form method="post" action="${CALE}/${c.id}/sterge" class="inline-form"
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
      <style>
        .editeaza-carac > summary { cursor:pointer; font-size:12px; color:var(--primary,#2f5d9c); font-weight:600; }
        .editeaza-form { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:6px 10px;
          margin-top:8px; padding:10px; border:1px solid var(--border,#e1e4e9); border-radius:8px;
          background:var(--bg,#f5f6f8); max-width:720px; }
        .editeaza-form label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text-muted); }
        .editeaza-form label.bif { flex-direction:row; align-items:center; gap:6px; font-size:12px; color:var(--text,#1c2230); }
        .editeaza-form .btn { grid-column:1 / -1; justify-self:start; }
      </style>
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
                 '<input name="cod[]" placeholder="V" maxlength="8" autocomplete="off" class="cod-valoare">';
               return d;
             }
             function faRanduriValori() {
               var cate = Math.max(1, Math.min(40, Number(document.getElementById("cate-valori").value) || 1));
               var gazda = document.getElementById("randuri-valori");
               // Ce-a scris omul deja nu se pierde cand mareste numarul.
               var vechi = [].slice.call(gazda.querySelectorAll(".rand-valoare")).map(function (r) {
                 var i = r.querySelectorAll("input");
                 return [i[0].value, i[1].value];
               });
               gazda.innerHTML = "";
               for (var i = 0; i < cate; i++) {
                 var r = randValoare(i + 1);
                 if (vechi[i]) {
                   var inp = r.querySelectorAll("input");
                   inp[0].value = vechi[i][0];
                   inp[1].value = vechi[i][1];
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
               @media (max-width: 760px) {
                 .rand-valoare { flex-wrap:wrap; }
                 .rand-valoare .cod-valoare { flex:1 1 100px; }
               }
             </style>
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
        areNum ? parseInt(b.cifre, 10) || 0 : c.cifre,
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
    for (let i = 0; i < valori.length; i++) {
      const valoare = String(valori[i] || "").trim();
      const cod = C.curat(coduri[i]);
      // Rândul gol de tot se sare fără zgomot: omul a cerut zece rânduri și a
      // completat șapte.
      if (!valoare && !cod) continue;
      lista.push({ valoare, cod });
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
        .prepare("INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine) VALUES (?,?,?,?)")
        .run(cid, v.valoare, v.cod, ++ordine);
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
    const { id } = await scrieProdusul(r, familieId, {
      um: b.unitate_masura,
      pret: b.pret_vanzare,
      stoc_minim: b.stoc_minim,
    });
    redirect(ctx.res, `/produse/${id}`);
  });
}

// Scrierea produsului dintr-un rezultat deja generat.
//
// Stă separat fiindcă îl cheamă două ecrane: „Produs nou" din nomenclator și
// comanda agentului. Dacă fiecare ar scrie cu INSERT-ul lui, unul dintre ele
// ar uita mai devreme sau mai târziu `cod_generat` sau caracteristicile, iar
// produsul ar intra în sistem fără codul după care îl caută toată lumea.
async function scrieProdusul(r, familieId, { um, pret, stoc_minim } = {}) {
  const ins = await db
    .prepare(
      `INSERT INTO produse (cod, cod_generat, denumire, unitate_masura, pret_vanzare, stoc_minim, cod_familie_id)
       VALUES (?,?,?,?,?,?,?) RETURNING id`
    )
    .run(r.cod, r.cod, r.denumire, String(um || "buc"), Number(pret) || 0, Number(stoc_minim) || 0, familieId || null);
  const id = Number(ins.lastInsertRowid);
  for (const buc of r.bucati_toate) {
    await db
      .prepare("INSERT INTO produse_cod_valori (produs_id, caracteristica_id, nume, valoare, bucata) VALUES (?,?,?,?,?)")
      .run(id, buc.id, buc.nume, buc.valoare, buc.cod || null);
  }
  return { id, cod: r.cod, denumire: r.denumire };
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
  if (r.exista) return { r, id: Number(r.exista.id), creat: false };
  // Un produs pe jumătate configurat n-are voie să intre în nomenclator: ar
  // rămâne acolo cu un cod scurt care se lovește de al altuia.
  if (!r.ok) return { r, id: null, creat: false };
  const scris = await scrieProdusul(r, familieId, extra);
  return { r, id: scris.id, creat: true };
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

module.exports = {
  register,
  seed,
  citesteCaracteristici,
  familii,
  genereaza,
  produsulAlegerilor,
  scrieProdusul,
  CALE,
};
