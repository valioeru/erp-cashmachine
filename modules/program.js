"use strict";
// PROGRAMUL DE LUCRU: cine vine, când, și la ce post.
//
// Până acum planificarea săptămânii se făcea într-un Excel trimis pe mail, iar
// ERP-ul afla despre ea nimic. Se vedea la alocare: lista de oameni arăta pe
// toți cei calificați, inclusiv pe cel care în ziua aia e pe tura de noapte și
// pe cel care sâmbăta nu vine deloc.
//
// Pagina asta face trei lucruri, în ordinea în care le face și omul:
//
//   1. SPUNE CÂT ȚINE UN SCHIMB. Orele nu sunt scrise în cod — se setează
//      aici și se țin în „setari_app", fiindcă programul unei hale se schimbă
//      mai des decât aplicația.
//
//   2. ÎNTREABĂ CE MERGE ȘI CINE POATE VENI. Ce utilaje au comenzi, în câte
//      schimburi, cu câți oameni pe schimb — și bifatul oamenilor disponibili
//      pe fiecare zi. Astea sunt singurele lucruri pe care le știe doar omul.
//
//   3. PROPUNE ÎMPĂRȚIREA. Restul e combinatorică, și acolo oamenii greșesc
//      nu pentru că n-ar ști, ci pentru că sunt prea multe variante ca să le
//      ții minte în timp ce sună telefonul. Propunerea NU se salvează singură:
//      se vede întâi, se schimbă dacă trebuie, și abia apoi se scrie.
const db = require("../lib/db");
const { esc, layout, dataRo, subnavProductie } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const S = require("../lib/schimburi");
const P = require("../lib/planificator");

const CHEIE_SCHIMBURI = "schimburi_ore";
const azi = () => new Date().toISOString().slice(0, 10);
const nr = (v) => Number(String(v == null ? "" : v).replace(",", ".")) || 0;

function poate(user) {
  return Boolean(user && ["admin", "productie", "depozit"].includes(user.rol));
}

// Luni din săptămâna unei date. Planificarea se discută pe săptămâni, nu pe
// ferestre de șapte zile care încep miercuri.
function luni(data) {
  const d = new Date(String(data) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return azi();
  const zi = d.getUTCDay() || 7; // duminică = 7
  d.setUTCDate(d.getUTCDate() - (zi - 1));
  return d.toISOString().slice(0, 10);
}
const ZILE_RO = ["lu", "ma", "mi", "jo", "vi", "sâ", "du"];
const numeZi = (data) => {
  const d = new Date(String(data) + "T00:00:00Z");
  return ZILE_RO[(d.getUTCDay() || 7) - 1] || "";
};
const eWeekend = (data) => {
  const z = new Date(String(data) + "T00:00:00Z").getUTCDay();
  return z === 0 || z === 6;
};

// Orele schimburilor, din configurare. Citite la fiecare cerere, nu o dată la
// pornire: altfel o schimbare ar cere repornirea aplicației.
async function incarcaSchimburi() {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(CHEIE_SCHIMBURI);
    if (r && r.valoare) S.configureaza(JSON.parse(r.valoare));
  } catch (e) {
    /* rămân orele implicite — mai bine așa decât o pagină care crapă */
  }
  return S.toate();
}

async function dateleSaptamanii(deLa) {
  const zile = [];
  for (let i = 0; i < 7; i++) zile.push(S.ziPlus(deLa, i));
  const oameni = await db
    .prepare(
      `SELECT r.id, r.nume, r.functie,
              (SELECT string_agg(CAST(rc.utilaj_id AS TEXT), ',') FROM resurse_competente rc WHERE rc.resursa_id = r.id) AS utilaje
         FROM resurse r WHERE r.activ = 1 ORDER BY r.nume`
    )
    .all();
  const nivele = await db.prepare("SELECT resursa_id, utilaj_id, nivel FROM resurse_competente").all().catch(() => []);
  const utilaje = await db.prepare("SELECT id, cod, denumire FROM utilaje WHERE activ = 1 ORDER BY cod").all();
  const program = await db
    .prepare("SELECT resursa_id, data, schimb, post FROM resurse_program WHERE data >= ? AND data <= ?")
    .all(zile[0], zile[6]);
  // Săptămâna dinainte — pentru regula „nimeni pe același schimb de două ori".
  const trecut = await db
    .prepare("SELECT resursa_id, schimb, COUNT(*) AS n FROM resurse_program WHERE data >= ? AND data < ? GROUP BY resursa_id, schimb ORDER BY n DESC")
    .all(S.ziPlus(deLa, -7), deLa)
    .catch(() => []);
  const schimbAnterior = {};
  for (const t of trecut) if (!schimbAnterior[t.resursa_id]) schimbAnterior[t.resursa_id] = t.schimb;
  return { zile, oameni, nivele, utilaje, program, schimbAnterior };
}

function pregatesteOameni(oameni, nivele) {
  const peOm = new Map();
  for (const n of nivele) {
    const k = Number(n.resursa_id);
    if (!peOm.has(k)) peOm.set(k, {});
    peOm.get(k)[Number(n.utilaj_id)] = Number(n.nivel);
  }
  return oameni.map((o) => ({
    id: Number(o.id),
    nume: o.nume,
    competente: String(o.utilaje || "").split(",").map(Number).filter(Boolean),
    nivel: peOm.get(Number(o.id)) || {},
  }));
}

function register(router) {
  // ---- Pagina ------------------------------------------------------------
  router.get("/productie/program", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const schimburi = await incarcaSchimburi();
    const deLa = luni(/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? ctx.query.de_la : azi());
    const d = await dateleSaptamanii(deLa);
    send(ctx.res, 200, pagina(ctx, deLa, d, schimburi, null, ""));
  });

  // ---- Orele schimburilor -------------------------------------------------
  router.post("/productie/program/schimburi", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/productie/program");
    const b = ctx.body || {};
    const lista = S.CODURI.map((cod) => ({ cod, start: nr(b["start_" + cod]), ore: nr(b["ore_" + cod]) || 8 }));
    const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
    const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(CHEIE_SCHIMBURI);
    if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(JSON.stringify(lista), acum, CHEIE_SCHIMBURI);
    else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(CHEIE_SCHIMBURI, JSON.stringify(lista), acum);
    S.configureaza(lista);
    redirect(ctx.res, "/productie/program?de_la=" + encodeURIComponent(String(b.de_la || azi())));
  });

  // ---- Propunerea ---------------------------------------------------------
  router.post("/productie/program/propune", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/productie/program");
    const b = ctx.body || {};
    const schimburi = await incarcaSchimburi();
    const deLa = luni(String(b.de_la || azi()));
    const d = await dateleSaptamanii(deLa);

    const posturi = d.utilaje
      .map((u) => ({
        utilaj_id: Number(u.id),
        cod: u.cod,
        denumire: u.denumire,
        schimburi: Math.round(nr(b["sch_" + u.id])),
        pePost: Math.round(nr(b["pe_" + u.id])) || 1,
      }))
      .filter((p) => p.schimburi > 0);

    const disponibil = {};
    for (const o of d.oameni) for (const zi of d.zile) if (b[`disp_${o.id}_${zi}`]) disponibil[P.cheieZi(o.id, zi)] = true;

    const propunere = P.propune({
      zile: d.zile,
      posturi,
      schimburi: ["S1", "S2", "S3"],
      oameni: pregatesteOameni(d.oameni, d.nivele),
      disponibil,
      schimbAnterior: d.schimbAnterior,
    });
    send(ctx.res, 200, pagina(ctx, deLa, d, schimburi, propunere, ""));
  });

  // ---- Salvarea propunerii ------------------------------------------------
  router.post("/productie/program/salveaza", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/productie/program");
    const b = ctx.body || {};
    const deLa = luni(String(b.de_la || azi()));
    let randuri = [];
    try {
      randuri = JSON.parse(String(b.program || "[]"));
    } catch (e) {
      return redirect(ctx.res, "/productie/program?de_la=" + encodeURIComponent(deLa));
    }
    const panaLa = S.ziPlus(deLa, 6);
    // Săptămâna se rescrie întreagă. Altfel, o propunere nouă s-ar amesteca cu
    // rămășițele celei vechi, iar nimeni n-ar mai ști ce e în vigoare.
    await db.prepare("DELETE FROM resurse_program WHERE data >= ? AND data <= ?").run(deLa, panaLa);
    let scrise = 0;
    for (const r of randuri) {
      const id = Number(r.resursa_id);
      const data = String(r.data || "").slice(0, 10);
      const schimb = S.normalizeaza(r.schimb);
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !schimb) continue;
      if (data < deLa || data > panaLa) continue;
      try {
        await db
          .prepare("INSERT INTO resurse_program (resursa_id, data, schimb, post) VALUES (?, ?, ?, ?)")
          .run(id, data, schimb, String(r.post || "").slice(0, 120) || null);
        scrise++;
      } catch (e) {
        /* un om pus de două ori în aceeași zi: unicitatea din schemă îl oprește */
      }
    }
    redirect(ctx.res, `/productie/program?de_la=${encodeURIComponent(deLa)}&scris=${scrise}`);
  });

  // ---- Un singur om, o singură zi (corecția manuală) ----------------------
  router.post("/productie/program/om", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/productie/program");
    const b = ctx.body || {};
    const id = Number(b.resursa_id);
    const data = String(b.data || "").slice(0, 10);
    const schimb = S.normalizeaza(b.schimb);
    if (id && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
      await db.prepare("DELETE FROM resurse_program WHERE resursa_id = ? AND data = ?").run(id, data);
      if (schimb) {
        await db
          .prepare("INSERT INTO resurse_program (resursa_id, data, schimb, post) VALUES (?, ?, ?, ?)")
          .run(id, data, schimb, String(b.post || "").slice(0, 120) || null);
      }
    }
    redirect(ctx.res, "/productie/program?de_la=" + encodeURIComponent(luni(data || azi())));
  });
}

// ---------------------------------------------------------------------------
function pagina(ctx, deLa, d, schimburi, propunere, mesaj) {
  const { zile, oameni, utilaje, program } = d;
  const poateEdita = poate(ctx.user);
  const programPe = new Map();
  for (const p of program) programPe.set(Number(p.resursa_id) + "|" + String(p.data).slice(0, 10), p);

  const capZile = zile
    .map((z) => `<th style="font-weight:500;font-size:11px;${eWeekend(z) ? "color:var(--text-muted)" : ""}">${numeZi(z)}<br>${z.slice(8)}.${z.slice(5, 7)}</th>`)
    .join("");

  // Grila a ce e salvat acum.
  const grila = `
    <table class="table" style="font-size:12px">
      <thead><tr><th style="text-align:left">Om</th>${capZile}<th>Zile</th></tr></thead>
      <tbody>
        ${
          oameni.length
            ? oameni
                .map((o) => {
                  let n = 0;
                  const celule = zile
                    .map((z) => {
                      const p = programPe.get(Number(o.id) + "|" + z);
                      if (p) n++;
                      return `<td style="text-align:center;${eWeekend(z) && !p ? "background:#fafafa" : ""}">${
                        p
                          ? `<span class="badge albastru" title="${esc(S.eticheta(p.schimb))}${p.post ? " · " + esc(p.post) : ""}">${esc(S.normalizeaza(p.schimb) || p.schimb)}</span>${p.post ? `<div style="font-size:10px;color:var(--text-muted)">${esc(p.post)}</div>` : ""}`
                          : ""
                      }</td>`;
                    })
                    .join("");
                  return `<tr><td style="white-space:nowrap"><a href="/productie/resurse/${o.id}">${esc(o.nume)}</a></td>${celule}<td style="text-align:center"><strong>${n}</strong></td></tr>`;
                })
                .join("")
            : `<tr><td colspan="${zile.length + 2}" class="empty">Niciun om în producție. <a href="/productie/resurse">Adaugă oameni.</a></td></tr>`
        }
      </tbody>
    </table>`;

  // Formularul: utilajele, apoi disponibilitatea.
  const randUtilaj = (u) => `
    <tr>
      <td style="white-space:nowrap">${esc(u.cod)} · ${esc(u.denumire)}</td>
      <td><select name="sch_${u.id}" style="width:120px">
        ${[0, 1, 2, 3].map((n) => `<option value="${n}">${n === 0 ? "nu merge" : n + " schimb" + (n > 1 ? "uri" : "")}</option>`).join("")}
      </select></td>
      <td><input type="number" name="pe_${u.id}" min="1" max="6" value="1" style="width:70px"></td>
    </tr>`;

  const randDisponibil = (o) => `
    <tr>
      <td style="white-space:nowrap">${esc(o.nume)}</td>
      ${zile
        .map((z) => {
          const are = programPe.has(Number(o.id) + "|" + z);
          return `<td style="text-align:center;${eWeekend(z) ? "background:#fafafa" : ""}"><input type="checkbox" name="disp_${o.id}_${z}" value="1"${are ? " checked" : ""}></td>`;
        })
        .join("")}
      <td><button type="button" class="link-btn" data-tot="${o.id}">toată săpt.</button></td>
    </tr>`;

  const formular = !poateEdita
    ? ""
    : `
    <form method="post" action="/productie/program/propune" class="form" style="margin-top:20px">
      <input type="hidden" name="de_la" value="${esc(deLa)}">
      <h2 style="margin-bottom:4px">1. Ce merge și în câte schimburi</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-top:0">Un schimb = ${schimburi[0].ore} ore. „Oameni pe schimb" e câți stau la utilaj deodată — la AWB sunt doi.</p>
      <table class="table" style="max-width:620px;font-size:13px">
        <thead><tr><th style="text-align:left">Utilaj</th><th>Schimburi pe zi</th><th>Oameni pe schimb</th></tr></thead>
        <tbody>${utilaje.map(randUtilaj).join("")}</tbody>
      </table>

      <h2 style="margin-bottom:4px;margin-top:18px">2. Cine poate veni</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-top:0">Bifat = omul poate veni în ziua aia. Pornesc bifate zilele în care are deja program scris.</p>
      <table class="table" style="font-size:12px">
        <thead><tr><th style="text-align:left">Om</th>${capZile}<th></th></tr></thead>
        <tbody>${oameni.map(randDisponibil).join("")}</tbody>
      </table>

      <div class="form-actions" style="margin-top:14px">
        <button class="btn" type="submit">3. Propune împărțirea</button>
        <span style="font-size:12px;color:var(--text-muted);margin-left:10px">Propunerea nu se salvează singură — o vezi întâi.</span>
      </div>
    </form>
    <script>
    document.querySelectorAll("[data-tot]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.tot;
        var cutii = document.querySelectorAll('input[name^="disp_' + id + '_"]');
        var toateBifate = [].every.call(cutii, function (c) { return c.checked; });
        cutii.forEach(function (c) { c.checked = !toateBifate; });
      });
    });
    </script>`;

  // Rezultatul propunerii.
  let rezultat = "";
  if (propunere) {
    const peZi = propunere.zile
      .map(
        (z) => `
        <h3 style="margin:14px 0 4px">${esc(numeZi(z.data))} ${esc(dataRo ? dataRo(z.data) : z.data)}
          <span style="font-weight:400;font-size:13px;color:var(--text-muted)">· ${z.acoperite} acoperite${z.neacoperite ? `, <strong style="color:var(--danger)">${z.neacoperite} goale</strong>` : ""}</span></h3>
        <table class="table" style="font-size:12.5px">
          <thead><tr><th style="text-align:left">Post</th><th>Schimb</th><th style="text-align:left">Cine</th></tr></thead>
          <tbody>${z.sloturi
            .map(
              (s) => `<tr>
                <td>${esc(s.cod)} · ${esc(s.denumire)}${s.pozitie ? ` <span style="color:var(--text-muted)">op. ${s.pozitie}</span>` : ""}</td>
                <td style="text-align:center">${esc(S.eticheta(s.schimb))}</td>
                <td>${
                  s.resursa_id
                    ? esc(s.nume) + (s.nivel === 1 ? ' <span class="badge galben">învață</span>' : "")
                    : `<span class="badge rosu">gol</span> <span style="color:var(--text-muted)">${esc(s.motiv || "")}</span>`
                }</td>
              </tr>`
            )
            .join("")}</tbody>
        </table>
        ${z.nefolositi.length ? `<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">Disponibili și nefolosiți: ${esc(z.nefolositi.map((x) => x.nume).join(", "))}</p>` : ""}`
      )
      .join("");

    rezultat = `
      <div class="detail-box" style="margin-top:20px;border-left:4px solid ${propunere.neacoperite ? "var(--danger)" : "var(--ok,#2e7d32)"}">
        <h2 style="margin-top:0">Propunere — ${propunere.total} repartizări${propunere.neacoperite ? `, <span style="color:var(--danger)">${propunere.neacoperite} posturi rămân goale</span>` : ", toate posturile acoperite"}</h2>
        ${
          propunere.incalcariRotatie.length
            ? `<p style="font-size:13px"><strong>Prind același schimb ca săptămâna trecută</strong> (n-a avut cine altcineva):
               ${esc([...new Set(propunere.incalcariRotatie.map((x) => x.nume))].join(", "))}</p>`
            : `<p style="font-size:13px;color:var(--text-muted)">Nimeni nu prinde același schimb ca săptămâna trecută.</p>`
        }
        ${
          propunere.schimburiAmestecate.length
            ? `<p style="font-size:13px">Prind schimburi diferite în aceeași săptămână:
               ${esc(propunere.schimburiAmestecate.map((x) => `${x.nume} (${x.schimburi.join("/")})`).join(", "))}</p>`
            : ""
        }
        <form method="post" action="/productie/program/salveaza" class="inline-form" style="margin-top:10px">
          <input type="hidden" name="de_la" value="${esc(deLa)}">
          <input type="hidden" name="program" value="${esc(JSON.stringify(propunere.program))}">
          <button class="btn" type="submit">Salvează propunerea ca program al săptămânii</button>
        </form>
        <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">Salvarea rescrie toată săptămâna ${esc(deLa)} → ${esc(S.ziPlus(deLa, 6))}.</p>
        ${peZi}
      </div>`;
  }

  const body = `
    ${subnavProductie("/productie/program", ctx.user)}
    ${ctx.query.scris ? `<p class="badge verde" style="display:inline-block">Program salvat: ${esc(String(ctx.query.scris))} repartizări.</p>` : ""}
    ${mesaj ? `<p class="badge rosu" style="display:inline-block">${esc(mesaj)}</p>` : ""}

    <form class="filtre" method="get" action="/productie/program">
      <label class="field" style="margin:0">Săptămâna de la<input type="date" name="de_la" value="${esc(deLa)}"></label>
      <button class="btn small" type="submit">Arată</button>
      <a class="btn small secondary" href="/productie/program?de_la=${esc(S.ziPlus(deLa, -7))}">← săptămâna trecută</a>
      <a class="btn small secondary" href="/productie/program?de_la=${esc(S.ziPlus(deLa, 7))}">săptămâna viitoare →</a>
    </form>

    <details style="margin:10px 0">
      <summary style="cursor:pointer;font-size:13px">Orele schimburilor: ${esc(schimburi.map((s) => s.eticheta).join(" · "))}</summary>
      ${
        poateEdita
          ? `<form method="post" action="/productie/program/schimburi" class="form" style="max-width:620px;margin-top:10px">
               <input type="hidden" name="de_la" value="${esc(deLa)}">
               <p style="font-size:12px;color:var(--text-muted);margin-top:0">Ora de început și câte ore ține. Schimbul 3 are voie să treacă peste miezul nopții.</p>
               ${schimburi
                 .map(
                   (s) => `<div style="display:grid;grid-template-columns:60px 1fr 1fr;gap:10px;align-items:end;margin-bottom:8px">
                     <strong>${esc(s.cod)}</strong>
                     <label class="field" style="margin:0"><span>Începe la ora</span><input type="number" name="start_${s.cod}" min="0" max="23" value="${s.start}"></label>
                     <label class="field" style="margin:0"><span>Ore</span><input type="number" name="ore_${s.cod}" min="1" max="24" value="${s.ore}"></label>
                   </div>`
                 )
                 .join("")}
               <button class="btn small" type="submit">Salvează orele</button>
             </form>`
          : ""
      }
    </details>

    <h2 style="margin-bottom:4px">Programul săptămânii</h2>
    ${grila}
    ${rezultat}
    ${formular}
  `;
  return layout({ user: ctx.user, title: "Program de lucru", active: "/productie", body });
}

module.exports = { register, luni, incarcaSchimburi, CHEIE_SCHIMBURI };
