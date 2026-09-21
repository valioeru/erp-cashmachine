"use strict";
// Inventarul fizic — marfa numărată, pusă față în față cu scripticul.
//
// DE CE, în cuvintele lui Vali: „în meniul depozit vreau un submeniu inventar
// unde să verificăm fizic produsele din stoc la zi cu realitatea, și să putem
// ajusta fizic după ce vedem comparativ și ne dă exact ce diferențe avem și ce
// valoare la preț de intrare a acelei marfi. Deasemenea tot acolo vreau să
// știu vechime maximă stoc pe fiecare cod de produs."
//
// Patru decizii stau la baza modulului, și fiecare are un motiv practic:
//
// 1. INVENTARUL E O SESIUNE, nu o apăsare. Se deschide, se numără pe rând —
//    poate dura o zi întreagă — se vede comparativ, și abia la final se
//    aplică. Până atunci stocul nu se clintește. Altfel, un inventar
//    întrerupt la jumătate ar lăsa depozitul într-o stare pe jumătate
//    corectată, care e mai rea decât cea de dinainte.
//
// 2. SCRIPTICUL SE FOTOGRAFIAZĂ LA DESCHIDERE. Dacă l-am citi la aplicare, o
//    intrare făcută între timp ar apărea drept diferență de inventar — și am
//    „corecta" o cifră care era corectă.
//
// 3. NENUMĂRAT NU ÎNSEAMNĂ ZERO. Câmpul rămâne gol până pune cineva o cifră.
//    Dacă le-am trata la fel, un inventar oprit la jumătate ar șterge stocul
//    tuturor produselor la care nu s-a ajuns.
//
// 4. TOTUL SE POATE DESFACE. Aplicarea scrie mișcări de tip „inventar", fiecare
//    purtând document_ref „inventar:<id>". Desfacerea șterge exact acele
//    mișcări și nimic altceva.
//
// Evaluarea diferențelor se face la PREȚ DE INTRARE: ultimul preț la care a
// intrat efectiv produsul, iar dacă n-a intrat niciodată cu preț, prețul de
// achiziție de pe fișă. Pagina spune la fiecare rând de unde a luat prețul —
// o valoare a lipsurilor calculată pe un preț inventat e mai rea decât una
// lipsă, fiindcă arată credibil.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { SUB_STOC } = require("../lib/stoc");

const nr = (v) => Number(v || 0);
const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const azi = () => new Date().toISOString().slice(0, 10);
const eAdmin = (u) => Boolean(u && u.rol === "admin");
// Depozitul e treaba depozitului: și „depozit" poate număra, nu doar adminul.
const poateInventaria = (u) => Boolean(u && (u.rol === "admin" || u.rol === "depozit"));

const LIMITA_RANDURI = 400;

// Cantitățile pot fi zecimale („12,5 kg"). Se acceptă și virgula, fiindcă
// asta tastează oricine în România, iar un „12,5" respins tăcut ca gol ar
// șterge stocul produsului la aplicare.
function cantitate(v) {
  const s = String(v == null ? "" : v).trim().replace(/\s/g, "").replace(",", ".");
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// ---- prețul de intrare, pe produs ------------------------------------------
// Ultima intrare cu preț e cea mai bună dovadă: e prețul la care marfa aia a
// ajuns efectiv la noi. Fișa produsului e a doua alegere.
async function preturiIntrare() {
  const harta = new Map();
  const dinFisa = await db.prepare("SELECT id, COALESCE(pret_achizitie, 0) AS pret FROM produse").all();
  for (const p of dinFisa) if (nr(p.pret) > 0) harta.set(Number(p.id), { pret: nr(p.pret), din: "fișa produsului" });
  const dinMiscari = await db
    .prepare(
      `SELECT DISTINCT ON (m.produs_id) m.produs_id, m.pret_unitar, SUBSTR(m.data, 1, 10) AS data
         FROM miscari_stoc m
        WHERE m.tip = 'intrare' AND COALESCE(m.pret_unitar, 0) > 0
        ORDER BY m.produs_id, m.data DESC, m.id DESC`
    )
    .all()
    .catch(() => []);
  for (const m of dinMiscari)
    harta.set(Number(m.produs_id), { pret: nr(m.pret_unitar), din: `ultima intrare, ${m.data}` });
  return harta;
}

// ---- deschiderea unui inventar ---------------------------------------------
async function deschide({ depozitId, nume, user }) {
  const r = await db
    .prepare("INSERT INTO inventare (depozit_id, nume, deschis_de) VALUES (?, ?, ?) RETURNING id")
    .run(depozitId, String(nume || "").trim() || `Inventar ${azi()}`, user && user.id ? user.id : null);
  const id = r.lastInsertRowid;

  // Fotografia scripticului: toate produsele care au stoc în depozitul ăsta.
  // Produsele cu stoc zero nu intră din start — dacă totuși găsești marfă la
  // raft, o adaugi de mână, exact cum se întâmplă în realitate.
  const preturi = await preturiIntrare();
  const randuri = await db
    .prepare(
      `SELECT s.produs_id, s.stoc
         FROM ${SUB_STOC} s
        WHERE s.depozit_id = ? AND s.stoc <> 0
        ORDER BY s.produs_id`
    )
    .all(depozitId);
  for (const x of randuri) {
    const p = preturi.get(Number(x.produs_id)) || { pret: 0, din: "fără preț cunoscut" };
    await db
      .prepare(
        `INSERT INTO inventare_linii (inventar_id, produs_id, scriptic, pret_intrare, pret_din)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
      )
      .run(id, x.produs_id, nr(x.stoc), p.pret, p.din);
  }
  return { id, linii: randuri.length };
}

async function inventarul(id) {
  return await db
    .prepare(
      `SELECT i.*, d.denumire AS depozit, u.nume AS autor
         FROM inventare i
         JOIN depozite d ON d.id = i.depozit_id
         LEFT JOIN utilizatori u ON u.id = i.deschis_de
        WHERE i.id = ?`
    )
    .get(id);
}

async function liniile(id) {
  return await db
    .prepare(
      `SELECT l.*, p.cod, p.denumire, COALESCE(p.unitate_masura, '') AS um
         FROM inventare_linii l JOIN produse p ON p.id = l.produs_id
        WHERE l.inventar_id = ?
        ORDER BY (CASE WHEN l.numarat IS NULL THEN 1 ELSE 0 END), p.denumire, p.id`
    )
    .all(id);
}

// ---- sumarul diferențelor ---------------------------------------------------
// Plusurile și minusurile NU se amestecă. Un depozit cu 10.000 lei lipsă și
// 10.000 lei în plus nu e un depozit în regulă: sunt două probleme, iar
// diferența netă zero le-ar ascunde pe amândouă.
function sumar(linii) {
  const s = {
    randuri: linii.length,
    numarate: 0,
    nenumarate: 0,
    potrivite: 0,
    plus: 0,
    minus: 0,
    valPlus: 0,
    valMinus: 0,
    faraPret: 0,
  };
  for (const l of linii) {
    if (l.numarat === null || l.numarat === undefined || l.numarat === "") {
      s.nenumarate++;
      continue;
    }
    s.numarate++;
    const dif = nr(l.numarat) - nr(l.scriptic);
    if (Math.abs(dif) < 0.0001) {
      s.potrivite++;
      continue;
    }
    if (!nr(l.pret_intrare)) s.faraPret++;
    if (dif > 0) {
      s.plus++;
      s.valPlus += dif * nr(l.pret_intrare);
    } else {
      s.minus++;
      s.valMinus += -dif * nr(l.pret_intrare);
    }
  }
  s.valNet = s.valPlus - s.valMinus;
  return s;
}

// ---- aplicarea --------------------------------------------------------------
// Se scrie o mișcare de tip „inventar" pentru fiecare linie NUMĂRATĂ, inclusiv
// pentru cele care se potrivesc: asta e definiția unui inventar — o fotografie
// a raftului, nu o listă de corecții. Liniile nenumărate nu se ating.
async function aplica(id, user) {
  const inv = await inventarul(id);
  if (!inv || inv.stare !== "deschis") return { ok: false, motiv: "inventarul nu mai e deschis" };
  const linii = (await liniile(id)).filter((l) => l.numarat !== null && l.numarat !== undefined);
  if (!linii.length) return { ok: false, motiv: "nu s-a numărat nimic" };
  const cand = acum();
  for (const l of linii) {
    await db
      .prepare(
        `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data, observatii)
         VALUES (?, ?, 'inventar', ?, ?, ?, ?, ?)`
      )
      .run(
        l.produs_id,
        inv.depozit_id,
        nr(l.numarat),
        nr(l.pret_intrare) || null,
        `inventar:${id}`,
        cand,
        `Inventar #${id}: scriptic ${nr(l.scriptic)}, numărat ${nr(l.numarat)}`
      );
  }
  await db
    .prepare("UPDATE inventare SET stare = 'aplicat', aplicat_de = ?, aplicat_la = ? WHERE id = ?")
    .run(user && user.id ? user.id : null, cand, id);
  return { ok: true, miscari: linii.length, sumar: sumar(linii) };
}

// Drumul de întoarcere: se șterg exact mișcările scrise de inventarul ăsta.
// E singura cale curată — o fotografie de stoc nu se „anulează" cu o alta,
// fiindcă atunci n-am mai ști care e adevărul.
async function desfa(id, user) {
  const inv = await inventarul(id);
  if (!inv || inv.stare !== "aplicat") return { ok: false, motiv: "inventarul nu e aplicat" };
  const n = await db
    .prepare("SELECT COUNT(*) AS n FROM miscari_stoc WHERE tip = 'inventar' AND document_ref = ?")
    .get(`inventar:${id}`);
  await db.prepare("DELETE FROM miscari_stoc WHERE tip = 'inventar' AND document_ref = ?").run(`inventar:${id}`);
  await db
    .prepare("UPDATE inventare SET stare = 'deschis', desfacut_de = ?, desfacut_la = ?, aplicat_la = NULL WHERE id = ?")
    .run(user && user.id ? user.id : null, acum(), id);
  return { ok: true, sterse: Number((n && n.n) || 0) };
}

// ---- vechimea stocului, pe cod de produs ------------------------------------
//
// „Vechime maximă stoc pe fiecare cod": de când zace cea mai veche bucată care
// încă e pe stoc. Se calculează FIFO — marfa veche pleacă prima — fiindcă asta
// e și realitatea din depozit, și regula contabilă.
//
// Un inventar rupe firul: după o fotografie de stoc nu mai știm din ce intrare
// provine marfa, doar că exista la acea dată. De-aia stratul cel mai vechi
// pleacă de la ultimul inventar, iar pagina o spune — „din inventarul de la…".
// Fără mențiunea asta, cifra ar părea mai precisă decât e.
async function vechimeStoc(depozitId) {
  const stocuri = await db
    .prepare(
      `SELECT s.produs_id, s.stoc, p.cod, p.denumire, COALESCE(p.unitate_masura,'') AS um
         FROM ${SUB_STOC} s JOIN produse p ON p.id = s.produs_id
        WHERE s.depozit_id = ? AND s.stoc > 0`
    )
    .all(depozitId);
  if (!stocuri.length) return [];
  const peProdus = new Map(stocuri.map((s) => [Number(s.produs_id), s]));

  const miscari = await db
    .prepare(
      `SELECT m.produs_id, m.tip, m.cantitate, SUBSTR(m.data, 1, 10) AS data
         FROM miscari_stoc m
        WHERE m.depozit_id = ?
        ORDER BY m.produs_id, m.data, m.id`
    )
    .all(depozitId);

  const grupe = new Map();
  for (const m of miscari) {
    const k = Number(m.produs_id);
    if (!peProdus.has(k)) continue;
    if (!grupe.has(k)) grupe.set(k, []);
    grupe.get(k).push(m);
  }

  const aziStr = azi();
  const zileIntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const out = [];
  for (const [produsId, p] of peProdus) {
    const lista = grupe.get(produsId) || [];
    // Se pornește de la ultimul inventar: înainte de el nu se mai știe nimic.
    let ultimulInventar = null;
    for (const m of lista) if (m.tip === "inventar") ultimulInventar = m;

    const straturi = [];
    let dinInventar = false;
    if (ultimulInventar) {
      if (nr(ultimulInventar.cantitate) > 0) {
        straturi.push({ data: ultimulInventar.data, cant: nr(ultimulInventar.cantitate) });
        dinInventar = true;
      }
      for (const m of lista) {
        if (m.data < ultimulInventar.data) continue;
        if (m === ultimulInventar) continue;
        if (m.tip === "inventar") continue;
        if (m.tip === "intrare") straturi.push({ data: m.data, cant: nr(m.cantitate) });
        else straturi.push({ data: m.data, cant: -nr(m.cantitate) });
      }
    } else {
      for (const m of lista) {
        if (m.tip === "inventar") continue;
        if (m.tip === "intrare") straturi.push({ data: m.data, cant: nr(m.cantitate) });
        else straturi.push({ data: m.data, cant: -nr(m.cantitate) });
      }
    }

    // FIFO: ieșirile mănâncă straturile de la cel mai vechi.
    const pool = [];
    for (const s of straturi) {
      if (s.cant > 0) {
        pool.push({ data: s.data, cant: s.cant });
        continue;
      }
      let deScos = -s.cant;
      while (deScos > 0.0001 && pool.length) {
        const cap = pool[0];
        const ia = Math.min(cap.cant, deScos);
        cap.cant -= ia;
        deScos -= ia;
        if (cap.cant <= 0.0001) pool.shift();
      }
    }
    const celMaiVechi = pool.length ? pool[0] : null;
    out.push({
      produs_id: produsId,
      cod: p.cod,
      denumire: p.denumire,
      um: p.um,
      stoc: nr(p.stoc),
      data: celMaiVechi ? celMaiVechi.data : null,
      zile: celMaiVechi ? Math.max(0, zileIntre(celMaiVechi.data, aziStr)) : null,
      cantVeche: celMaiVechi ? celMaiVechi.cant : null,
      dinInventar: dinInventar && celMaiVechi && ultimulInventar && celMaiVechi.data === ultimulInventar.data,
    });
  }
  out.sort((a, b) => (b.zile || -1) - (a.zile || -1));
  return out;
}

function badgeStare(stare) {
  if (stare === "aplicat") return '<span class="badge verde">aplicat</span>';
  return '<span class="badge galben">deschis</span>';
}

function register(router) {
  // ---- lista inventarelor --------------------------------------------------
  router.get("/depozit/inventar", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    const inventare = await db
      .prepare(
        `SELECT i.id, i.nume, i.stare, i.deschis_la, i.aplicat_la, d.denumire AS depozit,
                u.nume AS autor,
                (SELECT COUNT(*) FROM inventare_linii l WHERE l.inventar_id = i.id) AS randuri,
                (SELECT COUNT(*) FROM inventare_linii l WHERE l.inventar_id = i.id AND l.numarat IS NOT NULL) AS numarate
           FROM inventare i
           JOIN depozite d ON d.id = i.depozit_id
           LEFT JOIN utilizatori u ON u.id = i.deschis_de
          ORDER BY i.id DESC`
      )
      .all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY denumire").all();

    const body = `
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        Numeri marfa de pe raft și o pui față în față cu ce zice ERP-ul. Scripticul se fotografiază
        la deschidere, deci o intrare făcută între timp nu apare ca diferență. Până apeși „aplică",
        stocul nu se clintește — și după, se poate desface.
      </p>

      <div class="toolbar" style="margin-bottom:14px">
        <a class="btn secondary" href="/depozit/inventar/vechime">Vechimea stocului →</a>
      </div>

      <details style="margin-bottom:18px">
        <summary class="btn">Inventar nou</summary>
        <form method="post" action="/depozit/inventar" class="form" style="max-width:620px;margin-top:12px">
          <label class="field"><span>Depozit</span>
            <select name="depozit_id" required>
              <option value="">— alege depozitul —</option>
              ${depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span>Nume (opțional)</span><input name="nume" placeholder="Inventar ${azi()}"></label>
          <div class="form-actions"><button class="btn" type="submit">Deschide inventarul</button></div>
          <p style="font-size:12px;color:var(--text-muted);margin:0">
            Se face o listă cu toate produsele care au stoc în depozitul ales. Ce nu e pe listă dar găsești pe raft, adaugi de mână.
          </p>
        </form>
      </details>

      ${
        inventare.length
          ? table(
              ["#", "Nume", "Depozit", "Stare", "Numărate", "Deschis", "Aplicat", ""],
              inventare.map((i) => [
                String(i.id),
                `<a href="/depozit/inventar/${i.id}">${esc(i.nume || "—")}</a>`,
                esc(i.depozit),
                badgeStare(i.stare),
                `${i.numarate} / ${i.randuri}`,
                `${esc(String(i.deschis_la || "").slice(0, 16))}<br><span style="font-size:12px;color:var(--text-muted)">${esc(i.autor || "")}</span>`,
                esc(String(i.aplicat_la || "").slice(0, 16)) || "—",
                `<a class="link-btn" href="/depozit/inventar/${i.id}">deschide</a>`,
              ])
            )
          : "<p>Niciun inventar încă. Deschide unul cu butonul de mai sus.</p>"
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Inventar", active: "/depozit", body }));
  });

  router.post("/depozit/inventar", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    const depozitId = parseInt((ctx.body || {}).depozit_id, 10);
    if (!depozitId) return redirect(ctx.res, "/depozit/inventar");
    const r = await deschide({ depozitId, nume: (ctx.body || {}).nume, user: ctx.user });
    redirect(ctx.res, `/depozit/inventar/${r.id}`);
  });

  // ---- vechimea stocului ---------------------------------------------------
  // Ruta literală stă ÎNAINTEA lui /:id, altfel „vechime" ar fi citit ca id și
  // ar da 500. Vezi test-rute.js, care verifică asta la fiecare rulare.
  router.get("/depozit/inventar/vechime", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY denumire").all();
    const depozitId = parseInt(ctx.query.depozit || "", 10) || (depozite[0] && depozite[0].id) || 0;
    const randuri = depozitId ? await vechimeStoc(depozitId) : [];

    const prag = (z) => (z === null ? "—" : z >= 365 ? "rosu" : z >= 180 ? "galben" : "verde");
    const culoare = { rosu: "var(--danger)", galben: "var(--warn)", verde: "var(--success)" };
    const peste = (z) => randuri.filter((r) => r.zile !== null && r.zile >= z).length;

    const body = `
      <div class="toolbar" style="margin-bottom:10px"><a class="btn secondary" href="/depozit/inventar">← Înapoi la inventare</a></div>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        De când zace pe raft cea mai veche bucată care <em>încă</em> e pe stoc, pe fiecare cod.
        Se calculează FIFO — marfa veche pleacă prima — fiindcă așa se întâmplă și în depozit.
        Un inventar rupe firul: după o fotografie de stoc nu mai știm din ce intrare provine marfa,
        doar că exista atunci; rândurile alea sunt marcate.
      </p>

      <form class="filtre" method="get" action="/depozit/inventar/vechime" style="margin-bottom:14px">
        <select name="depozit" onchange="this.form.submit()">
          ${depozite.map((d) => `<option value="${d.id}"${depozitId === d.id ? " selected" : ""}>${esc(d.denumire)}</option>`).join("")}
        </select>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Coduri pe stoc</div><div class="value">${randuri.length}</div></div>
        <div class="card"><div class="label">Peste 180 de zile</div><div class="value" style="color:var(--warn)">${peste(180)}</div></div>
        <div class="card"><div class="label">Peste un an</div><div class="value" style="color:var(--danger)">${peste(365)}</div></div>
      </div>

      ${
        randuri.length
          ? table(
              ["Cod", "Produs", "Stoc", "Cea mai veche bucată", "Vechime", "Cantitatea veche"],
              randuri.slice(0, LIMITA_RANDURI).map((r) => [
                esc(r.cod || "—"),
                `<a href="/produse/${r.produs_id}">${esc(String(r.denumire || "").slice(0, 60))}</a>`,
                `${r.stoc} ${esc(r.um)}`,
                r.data
                  ? esc(r.data) + (r.dinInventar ? ' <span style="font-size:11px;color:var(--text-muted)">(din inventar)</span>' : "")
                  : '<span style="color:var(--text-muted)">nu se poate ști</span>',
                r.zile === null
                  ? "—"
                  : `<strong style="color:${culoare[prag(r.zile)]}">${r.zile} zile</strong>`,
                r.cantVeche === null ? "—" : `${Math.round(r.cantVeche * 1000) / 1000} ${esc(r.um)}`,
              ])
            ) +
            (randuri.length > LIMITA_RANDURI
              ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele ${LIMITA_RANDURI} din ${randuri.length}, cele mai vechi întâi.</p>`
              : "")
          : "<p>Niciun produs cu stoc în depozitul ales.</p>"
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Vechimea stocului", active: "/depozit", body }));
  });

  // ---- foaia de inventar ---------------------------------------------------
  router.get("/depozit/inventar/:id", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    if (!/^\d+$/.test(String(ctx.params.id || ""))) return redirect(ctx.res, "/depozit/inventar");
    const inv = await inventarul(ctx.params.id);
    if (!inv) return redirect(ctx.res, "/depozit/inventar");
    const linii = await liniile(inv.id);
    const s = sumar(linii);
    const deschis = inv.stare === "deschis";

    const randuri = linii.slice(0, LIMITA_RANDURI).map((l) => {
      const numarat = l.numarat === null || l.numarat === undefined ? "" : String(l.numarat);
      const dif = numarat === "" ? null : nr(l.numarat) - nr(l.scriptic);
      const val = dif === null ? null : dif * nr(l.pret_intrare);
      return [
        esc(l.cod || "—"),
        `<a href="/produse/${l.produs_id}">${esc(String(l.denumire || "").slice(0, 55))}</a>`,
        `${nr(l.scriptic)} ${esc(l.um)}`,
        deschis
          ? `<input name="c_${l.produs_id}" value="${esc(numarat)}" inputmode="decimal" style="width:90px" data-scriptic="${nr(l.scriptic)}">`
          : numarat === ""
          ? '<span style="color:var(--text-muted)">nenumărat</span>'
          : esc(numarat),
        dif === null
          ? '<span style="color:var(--text-muted)">—</span>'
          : Math.abs(dif) < 0.0001
          ? '<span style="color:var(--success)">0</span>'
          : `<strong style="color:${dif > 0 ? "var(--success)" : "var(--danger)"}">${dif > 0 ? "+" : ""}${Math.round(dif * 1000) / 1000}</strong>`,
        val === null ? "—" : money(val),
        `<span style="font-size:11px;color:var(--text-muted)">${esc(l.pret_din || "—")}${nr(l.pret_intrare) ? ` · ${money(l.pret_intrare)}` : ""}</span>`,
      ];
    });

    const body = `
      <div class="toolbar" style="margin-bottom:10px">
        <a class="btn secondary" href="/depozit/inventar">← Toate inventarele</a>
        ${badgeStare(inv.stare)}
      </div>
      <h1 style="margin:6px 0 2px">${esc(inv.nume || "Inventar")} · ${esc(inv.depozit)}</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px">
        Deschis ${esc(String(inv.deschis_la || "").slice(0, 16))}${inv.autor ? ` de ${esc(inv.autor)}` : ""}${
      inv.aplicat_la ? ` · aplicat ${esc(String(inv.aplicat_la).slice(0, 16))}` : ""
    }
      </p>

      <div class="cards">
        <div class="card"><div class="label">Numărate</div><div class="value">${s.numarate} / ${s.randuri}</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.nenumarate} nenumărate</div></div>
        <div class="card"><div class="label">Se potrivesc</div><div class="value" style="color:var(--success)">${s.potrivite}</div></div>
        <div class="card"><div class="label">Găsit în plus</div><div class="value">${s.plus}</div>
          <div style="font-size:12px;color:var(--success)">${money(s.valPlus)}</div></div>
        <div class="card"><div class="label">Lipsă</div><div class="value">${s.minus}</div>
          <div style="font-size:12px;color:var(--danger)">${money(s.valMinus)}</div></div>
        <div class="card"><div class="label">Diferență netă</div>
          <div class="value" style="color:${s.valNet < 0 ? "var(--danger)" : "var(--success)"}">${money(s.valNet)}</div>
          <div style="font-size:12px;color:var(--text-muted)">la preț de intrare</div></div>
      </div>
      ${
        s.faraPret
          ? `<p style="margin:12px 0 0;color:var(--warn);font-size:13px">
               ${s.faraPret} ${s.faraPret === 1 ? "diferență nu are preț de intrare cunoscut" : "diferențe n-au preț de intrare cunoscut"} —
               cantitatea se corectează oricum, dar valoarea lor nu intră în sumele de mai sus.
             </p>`
          : ""
      }

      ${
        deschis
          ? `<form method="post" action="/depozit/inventar/${inv.id}/salveaza">
               <div class="toolbar" style="margin:16px 0 10px;gap:10px">
                 <button class="btn" type="submit">Salvează ce am numărat</button>
                 <input id="cauta-produs" placeholder="caută în listă…" style="max-width:240px">
                 <span style="font-size:12px;color:var(--text-muted)">Lasă gol ce n-ai numărat încă — gol nu înseamnă zero.</span>
               </div>
               ${table(["Cod", "Produs", "Scriptic", "Numărat", "Diferență", "Valoare", "Preț de intrare"], randuri)}
               <div class="form-actions"><button class="btn" type="submit">Salvează ce am numărat</button></div>
             </form>`
          : table(["Cod", "Produs", "Scriptic", "Numărat", "Diferență", "Valoare", "Preț de intrare"], randuri)
      }
      ${
        linii.length > LIMITA_RANDURI
          ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele ${LIMITA_RANDURI} din ${linii.length} — nenumăratele întâi.</p>`
          : ""
      }

      ${
        deschis
          ? `<form method="post" action="/depozit/inventar/${inv.id}/aplica" style="margin-top:22px"
                   onsubmit="return confirm('Aplic inventarul? Se corectează stocul la ${s.numarate} produse numărate. Se poate desface.')">
               <button class="btn" type="submit"${s.numarate ? "" : " disabled"}>Aplică inventarul (${s.numarate} produse)</button>
               <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Scrie stocul numărat. Liniile nenumărate rămân neatinse.</span>
             </form>`
          : `<form method="post" action="/depozit/inventar/${inv.id}/desfa" style="margin-top:22px"
                   onsubmit="return confirm('Desfac inventarul? Stocul se întoarce cum era înainte de aplicare.')">
               <button class="btn secondary" type="submit">Desfă inventarul</button>
               <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Șterge exact mișcările scrise de inventarul ăsta, nimic altceva.</span>
             </form>`
      }

      <script>
        (function () {
          var c = document.getElementById("cauta-produs");
          if (!c) return;
          c.addEventListener("input", function () {
            var t = c.value.trim().toLowerCase();
            var randuri = document.querySelectorAll("table tbody tr");
            for (var i = 0; i < randuri.length; i++) {
              var r = randuri[i];
              r.style.display = !t || r.innerText.toLowerCase().indexOf(t) >= 0 ? "" : "none";
            }
          });
        })();
      </script>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Inventar", active: "/depozit", body }));
  });

  // Salvarea numărătorii. Se scrie doar ce s-a schimbat, și se lasă în pace
  // câmpurile goale: gol înseamnă „n-am ajuns acolo", nu „zero".
  router.post("/depozit/inventar/:id/salveaza", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    const inv = await inventarul(ctx.params.id);
    if (!inv || inv.stare !== "deschis") return redirect(ctx.res, `/depozit/inventar/${ctx.params.id}`);
    const b = ctx.body || {};
    const cand = acum();
    let scrise = 0;
    for (const cheie of Object.keys(b)) {
      if (!cheie.startsWith("c_")) continue;
      const produsId = parseInt(cheie.slice(2), 10);
      if (!produsId) continue;
      const v = cantitate(b[cheie]);
      await db
        .prepare(
          `UPDATE inventare_linii SET numarat = ?, numarat_de = ?, numarat_la = ?
            WHERE inventar_id = ? AND produs_id = ?`
        )
        .run(v, v === null ? null : ctx.user && ctx.user.id ? ctx.user.id : null, v === null ? null : cand, inv.id, produsId);
      if (v !== null) scrise++;
    }
    redirect(ctx.res, `/depozit/inventar/${inv.id}?salvate=${scrise}`);
  });

  router.post("/depozit/inventar/:id/aplica", async (ctx) => {
    if (!poateInventaria(ctx.user)) return redirect(ctx.res, "/stocuri");
    const r = await aplica(parseInt(ctx.params.id, 10), ctx.user);
    redirect(ctx.res, `/depozit/inventar/${ctx.params.id}${r.ok ? `?aplicat=${r.miscari}` : "?eroare=1"}`);
  });

  router.post("/depozit/inventar/:id/desfa", async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, `/depozit/inventar/${ctx.params.id}`);
    const r = await desfa(parseInt(ctx.params.id, 10), ctx.user);
    redirect(ctx.res, `/depozit/inventar/${ctx.params.id}${r.ok ? `?desfacut=${r.sterse}` : "?eroare=1"}`);
  });
}

module.exports = {
  register,
  deschide,
  aplica,
  desfa,
  sumar,
  liniile,
  vechimeStoc,
  cantitate,
  preturiIntrare,
};
