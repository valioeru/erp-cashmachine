"use strict";
// Rețetele de fabricație — din ce e făcut fiecare produs pe care îl producem,
// și cât costă o bucată din el.
//
// De ce contează: pentru marfa cumpărată, costul e prețul de pe factura
// furnizorului. Pentru ce facem noi nu există așa ceva — costul se adună din
// componente. Fără rețetă, un produs finit intră în calculul marjei cu o
// estimare, iar marja pe el e o părere. Cu rețetă, costul lui e știut din ziua
// în care s-a definit, nu după ce se închide luna.
//
// Rețetele se pot aduce automat, din rapoartele de producție ale contabilității
// (prin punte), sau se scriu de mână aici. Cantitatea unei componente e
// întotdeauna raportată la O BUCATĂ de produs finit — nu la un lot, nu la o
// șarjă. Rețetele venite din rapoarte se împart la cantitatea produsă, tocmai
// ca să iasă tot pe bucată; când raportul e strâmb, iese un cost aberant, și
// pagina asta îl arată în loc să-l ascundă.

const db = require("../lib/db");
const cost = require("../lib/cost");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => {
  const n = Number(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const bani4 = (v) =>
  Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + " lei";

// Unitatea de măsură, dar numai dacă e chiar o unitate. La un import vechi,
// aproape 3.000 de produse au primit în „unitate de măsură" chiar denumirea
// lor („Cutie 400X360X400 CM"). Afișată ca atare, ar face fiecare cantitate de
// pe pagină de necitit. O ascundem aici și o semnalăm la Verificări date, ca
// să se repare la sursă, nu prin ocolire.
function um(p) {
  const u = String((p && p.unitate_masura) || "").trim();
  if (!u) return "";
  if (u.length > 12) return "";
  if (u.toLowerCase() === String((p && p.denumire) || "").trim().toLowerCase()) return "";
  return u;
}

// Un cost de rețetă e „de verificat" dacă e departe de prețul cu care se vinde
// produsul. Sub 5% din preț înseamnă că rețeta e incompletă; peste trei ori
// prețul înseamnă aproape sigur o rețetă scrisă pe lot, nu pe bucată. Nu
// corectăm nimic singuri — n-avem de unde ști câte bucăți avea lotul — dar
// spunem că cifra nu se poate folosi ca atare.
function verdict(costReteta, pretReper) {
  const c = Number(costReteta) || 0;
  const p = Number(pretReper) || 0;
  if (!(c > 0)) return { cheie: "fara", text: "fără cost", clasa: "gri" };
  if (!(p > 0)) return { cheie: "necunoscut", text: "n-avem cu ce compara", clasa: "gri" };
  if (c > 3 * p) return { cheie: "prea_mare", text: "de verificat — pare pe lot, nu pe bucată", clasa: "rosu" };
  if (c < 0.05 * p) return { cheie: "prea_mic", text: "de verificat — pare incompletă", clasa: "galben" };
  return { cheie: "ok", text: "plauzibil", clasa: "verde" };
}

// Prețul de referință cu care judecăm costul: întâi cât s-a facturat efectiv
// pe produsul ăsta (media), fiindcă e ce a plătit clientul; dacă nu s-a vândut
// niciodată, prețul de vânzare din catalog.
async function preturiReper() {
  const randuri = await db
    .prepare(
      `SELECT fl.produs_id AS id, AVG(fl.pret_unitar) AS mediu, COUNT(*) AS linii
         FROM facturi_linii fl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
        WHERE f.directie = 'vanzare' AND fl.produs_id IS NOT NULL AND fl.pret_unitar > 0
        GROUP BY fl.produs_id`
    )
    .all()
    .catch(() => []);
  const m = new Map();
  for (const r of randuri) m.set(Number(r.id), { mediu: Number(r.mediu) || 0, linii: Number(r.linii) || 0 });
  return m;
}

function register(router) {
  // ---- Lista rețetelor --------------------------------------------------
  router.get("/productie/retete", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const cauta = String(ctx.query.q || "").trim();

    const cuReteta = await db
      .prepare(
        `SELECT p.id, p.cod, p.denumire, p.unitate_masura, p.pret_vanzare, p.pret_achizitie,
                p.cost_reteta, p.cost_reteta_lipsa, p.cost_rata,
                (SELECT COUNT(*) FROM retete_componente rc WHERE rc.produs_id = p.id) AS componente
           FROM produse p
          WHERE EXISTS (SELECT 1 FROM retete_componente rc WHERE rc.produs_id = p.id)
          ORDER BY p.denumire
          LIMIT 500`
      )
      .all()
      .catch(() => []);

    // Ce se vinde, dar n-are nici rețetă, nici cost măsurat: exact produsele
    // pentru care marja e o estimare. Ordonate după cât s-a vândut din ele,
    // fiindcă acolo se câștigă cel mai mult din scris o rețetă.
    const faraReteta = await db
      .prepare(
        `SELECT p.id, p.cod, p.denumire, p.unitate_masura, p.pret_vanzare,
                SUM(fl.cantitate * fl.pret_unitar) AS vanzari,
                SUM(fl.cantitate) AS cantitate
           FROM facturi_linii fl
           JOIN produse p ON p.id = fl.produs_id
           JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
          WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
            AND COALESCE(f.intercompany,0) = 0
            AND NOT EXISTS (SELECT 1 FROM retete_componente rc WHERE rc.produs_id = p.id)
            AND COALESCE(p.cost_rata, 0) <= 0 AND COALESCE(p.pret_achizitie, 0) <= 0
          GROUP BY p.id, p.cod, p.denumire, p.unitate_masura, p.pret_vanzare
          ORDER BY vanzari DESC
          LIMIT 40`
      )
      .all()
      .catch(() => []);

    const reper = await preturiReper();
    const cu = cuReteta.map((p) => {
      const r = reper.get(Number(p.id));
      const pretReper = r && r.mediu > 0 ? r.mediu : Number(p.pret_vanzare) || 0;
      return { ...p, pretReper, sursaReper: r && r.mediu > 0 ? "media facturată" : Number(p.pret_vanzare) > 0 ? "preț de catalog" : "", v: verdict(p.cost_reteta, pretReper) };
    });

    const filtrate = cauta
      ? cu.filter((p) => `${p.denumire} ${p.cod || ""}`.toLowerCase().includes(cauta.toLowerCase()))
      : cu;

    const complete = cu.filter((p) => Number(p.cost_reteta) > 0 && !Number(p.cost_reteta_lipsa)).length;
    const partiale = cu.filter((p) => Number(p.cost_reteta) > 0 && Number(p.cost_reteta_lipsa) > 0).length;
    const faraCost = cu.filter((p) => !(Number(p.cost_reteta) > 0)).length;
    const deVerificat = cu.filter((p) => p.v.cheie === "prea_mare" || p.v.cheie === "prea_mic").length;

    // De verificat primele: sunt cifre care mint acum, nu lipsuri.
    const ordonate = filtrate.slice().sort((a, b) => {
      const scor = (x) => (x.v.cheie === "prea_mare" ? 0 : x.v.cheie === "prea_mic" ? 1 : x.v.cheie === "fara" ? 2 : 3);
      return scor(a) - scor(b) || String(a.denumire).localeCompare(String(b.denumire), "ro");
    });

    const body = `
      <div class="toolbar">
        <a class="btn secondary" href="/produse">Catalogul de produse</a>
        ${ctx.user.rol === "admin"
          ? `<form method="post" action="/productie/retete/recalculeaza" class="inline-form"><button class="btn secondary" type="submit">Recalculează costurile din rețete</button></form>`
          : ""}
      </div>
      ${ctx.query.recalculat !== undefined
        ? `<div class="flash">Recalculat: <b>${esc(String(ctx.query.cu_cost || 0))}</b> produse au cost din rețetă (${esc(String(ctx.query.complete || 0))} complete, ${esc(String(ctx.query.partiale || 0))} parțiale).</div>`
        : ""}

      <p class="explic">
        Rețeta spune din ce e făcută <strong>o bucată</strong> de produs finit. Din ea iese costul lui, fără să
        aștepte nicio factură și niciun raport de la contabilitate. Costul din rețetă intră direct în marjă:
        e a doua treaptă, după costul real din contabilitate și înaintea prețului de achiziție.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Produse cu rețetă</div><div class="value">${cu.length}</div>
          <div class="mic">${complete} cu toate componentele costate, ${partiale} parțial</div></div>
        <div class="card"><div class="label">Rețete de verificat</div>
          <div class="value" style="color:${deVerificat ? "var(--danger)" : "inherit"}">${deVerificat}</div>
          <div class="mic">costul nu se potrivește cu prețul de vânzare</div></div>
        <div class="card"><div class="label">Rețete fără cost</div><div class="value">${faraCost}</div>
          <div class="mic">nicio componentă n-are preț</div></div>
        <div class="card"><div class="label">Se vând fără cost și fără rețetă</div>
          <div class="value" style="color:${faraReteta.length ? "var(--warn)" : "inherit"}">${faraReteta.length}</div>
          <div class="mic">pentru ele marja e estimată cu rata firmei</div></div>
      </div>

      ${
        faraReteta.length
          ? `<h2>Se vând, dar nu știm din ce sunt făcute</h2>
             <p class="explic">
               Produsele astea au vânzări, dar n-au nici rețetă, nici preț de achiziție, nici cost din contabilitate.
               Marja pe ele e estimată cu rata firmei. Sunt puse în ordinea cât s-a vândut din fiecare — scrie rețeta
               la primele câteva și o bună parte din estimare dispare.
             </p>
             ${table(
               ["#", "Cod", "Produs", "Cantitate vândută", "Vânzări", "Preț catalog", ""],
               faraReteta.map((p, i) => [
                 String(i + 1),
                 esc(p.cod || "—"),
                 `<a href="/productie/retete/${p.id}">${esc(p.denumire)}</a>`,
                 `${Number(p.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 2 })} ${esc(um(p))}`,
                 money(p.vanzari),
                 Number(p.pret_vanzare) > 0 ? money(p.pret_vanzare) : "—",
                 `<a class="btn small" href="/productie/retete/${p.id}">Scrie rețeta</a>`,
               ])
             )}`
          : ""
      }

      <h2>Produsele cu rețetă (${ordonate.length}${cauta ? ` din ${cu.length}` : ""})</h2>
      <form class="filtre" method="get" action="/productie/retete">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută produsul…" style="min-width:280px">
        <button class="btn small" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary small" href="/productie/retete">Arată tot</a>` : ""}
      </form>
      ${
        ordonate.length
          ? table(
              ["Produs", "UM", "Componente", "Cost pe bucată", "Preț de referință", "Marjă", "Stare", ""],
              ordonate.map((p) => {
                const c = Number(p.cost_reteta) || 0;
                const pr = Number(p.pretReper) || 0;
                const marja = pr > 0 && c > 0 ? ((pr - c) / pr) * 100 : null;
                return [
                  `<a href="/productie/retete/${p.id}">${esc(p.denumire)}</a>${p.cod ? `<br><span style="color:var(--text-muted);font-size:11px">${esc(p.cod)}</span>` : ""}`,
                  esc(um(p)),
                  `${p.componente}${Number(p.cost_reteta_lipsa) > 0 ? ` <span style="color:var(--warn);font-size:11px">(${p.cost_reteta_lipsa} fără cost)</span>` : ""}`,
                  c > 0 ? bani4(c) : `<span style="color:var(--text-muted)">—</span>`,
                  pr > 0 ? `${money(pr)}<br><span style="color:var(--text-muted);font-size:11px">${esc(p.sursaReper)}</span>` : "—",
                  marja === null ? "—" : `<strong style="color:${marja >= 0 ? "var(--success)" : "var(--danger)"}">${marja.toFixed(1)}%</strong>`,
                  `<span class="badge ${p.v.clasa}">${esc(p.v.text)}</span>`,
                  `<a class="btn small secondary" href="/productie/retete/${p.id}">Deschide</a>`,
                ];
              })
            )
          : `<p style="color:var(--text-muted)">Niciun produs cu rețetă${cauta ? " care să semene cu „" + esc(cauta) + "”" : ""}.</p>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Rețete de fabricație", active: "/productie/retete", body }));
  });

  router.post("/productie/retete/recalculeaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const r = await cost.recalculeazaRetete();
    return redirect(
      ctx.res,
      "/productie/retete?" +
        new URLSearchParams({ recalculat: "1", cu_cost: String(r.cu_cost), complete: String(r.complete), partiale: String(r.partiale) }).toString()
    );
  });

  // ---- Rețeta unui produs ------------------------------------------------
  router.get("/productie/retete/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const p = await db
      .prepare("SELECT id, cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, cost_reteta, cost_reteta_lipsa, cost_rata FROM produse WHERE id = ?")
      .get(ctx.params.id);
    if (!p) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/productie/retete", body: "<p>Produsul nu există.</p>" }));

    const d = await cost.detaliuReteta(p.id);
    const reper = await preturiReper();
    const r = reper.get(Number(p.id));
    const pretReper = r && r.mediu > 0 ? r.mediu : Number(p.pret_vanzare) || 0;
    const v = verdict(d.total, pretReper);
    const marja = pretReper > 0 && d.total > 0 ? ((pretReper - d.total) / pretReper) * 100 : null;

    const candidati = await db
      .prepare("SELECT id, denumire, unitate_masura, pret_achizitie FROM produse WHERE id != ? ORDER BY denumire LIMIT 4000")
      .all(p.id);

    const body = `
      <div class="toolbar">
        <a class="btn secondary" href="/productie/retete">← Toate rețetele</a>
        <a class="btn secondary" href="/produse/${p.id}">Fișa produsului</a>
      </div>
      ${ctx.query.eroare ? `<div class="flash flash-rosu">${esc(String(ctx.query.eroare))}</div>` : ""}

      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Cod</div>${esc(p.cod || "—")}</div>
          <div><div class="k">Unitate de măsură</div>${esc(um(p) || "—")}</div>
          <div><div class="k">Cost din rețetă, pe bucată</div>${d.total > 0 ? `<strong>${bani4(d.total)}</strong>` : "—"}</div>
          <div><div class="k">Preț de referință</div>${pretReper > 0 ? money(pretReper) : "—"}<br><span style="color:var(--text-muted);font-size:11px">${r && r.mediu > 0 ? `media a ${r.linii} linii facturate` : "preț de catalog"}</span></div>
          <div><div class="k">Marjă la prețul ăsta</div>${
            marja === null
              ? "—"
              : `<strong style="color:${marja >= 0 ? "var(--success)" : "var(--danger)"}">${bani4(pretReper - d.total)}</strong> <span style="color:var(--text-muted);font-size:11px">${marja.toFixed(1)}%</span>`
          }</div>
          <div><div class="k">Stare</div><span class="badge ${v.clasa}">${esc(v.text)}</span></div>
          <div><div class="k">Preț de achiziție scris pe produs</div>${Number(p.pret_achizitie) > 0 ? money(p.pret_achizitie) : "—"}</div>
          <div><div class="k">Cost real din contabilitate</div>${Number(p.cost_rata) > 0 && pretReper > 0 ? `${money(Number(p.cost_rata) * pretReper)}<br><span style="color:var(--text-muted);font-size:11px">${(Number(p.cost_rata) * 100).toFixed(1)}% din preț</span>` : "—"}</div>
        </div>
      </div>

      ${
        v.cheie === "prea_mare"
          ? `<div class="detail-box" style="border-left:4px solid var(--danger)">
               <strong>Costul ăsta nu se poate folosi ca atare.</strong> Iese de ${(d.total / pretReper).toFixed(0)} ori mai mare
               decât prețul la care se vinde produsul. Aproape sigur rețeta a venit dintr-un raport de producție scris
               <em>pe lot</em>: cantitățile sunt cât s-a consumat pentru toată șarja, nu pentru o bucată. Împarte-le la
               câte bucăți au ieșit din lotul ăla și cifra devine reală.
             </div>`
          : ""
      }
      ${
        v.cheie === "prea_mic"
          ? `<div class="detail-box" style="border-left:4px solid var(--warn)">
               Costul din rețetă e sub 5% din prețul de vânzare. De obicei înseamnă că lipsesc componente din rețetă,
               nu că produsul are marjă de 95%.
             </div>`
          : ""
      }

      <h2>Din ce e făcută o bucată de ${esc(p.denumire)}</h2>
      <p class="explic">
        Cantitățile sunt <strong>pe o singură bucată</strong> de produs finit. Costul fiecărei componente se ia din
        rețeta ei, dacă e și ea făcută de noi, altfel din prețul ei de achiziție. Ce n-are cost apare pe roșu și nu
        se pune la total — un cost parțial e o limită de jos, nu o cifră finală.
      </p>
      ${
        d.linii.length
          ? table(
              ["Componentă", "Cantitate / bucată", "UM", "Cost unitar", "De unde", "Cost în produs", ""],
              d.linii
                .slice()
                .sort((a, b) => b.cost - a.cost)
                .map((l) => [
                  `<a href="/productie/retete/${l.componenta_id}">${esc(l.denumire)}</a>`,
                  Number(l.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 6 }),
                  esc(um({ unitate_masura: l.um, denumire: l.denumire })),
                  l.cost_unitar > 0 ? bani4(l.cost_unitar) : `<span style="color:var(--danger)">fără cost</span>`,
                  `<span style="color:var(--text-muted);font-size:12px">${esc(l.temei)}</span>`,
                  l.cost > 0 ? bani4(l.cost) : "—",
                  `<form method="post" action="/productie/retete/${p.id}/sterge" class="inline-form" onsubmit="return confirm('Scoți componenta din rețetă?')">
                     <input type="hidden" name="componenta_id" value="${l.componenta_id}">
                     <button class="link-btn danger" type="submit">Scoate</button>
                   </form>`,
                ]),
              { total: ["TOTAL pe bucată", "", "", "", "", d.total > 0 ? bani4(d.total) : "—", ""] }
            )
          : `<p style="color:var(--text-muted)">Rețeta nu e definită încă. Adaugă prima componentă mai jos.</p>`
      }
      ${d.lipsa ? `<p style="font-size:12px;color:var(--warn)">${d.lipsa} ${d.lipsa === 1 ? "componentă n-are" : "componente n-au"} cost, deci totalul e incomplet.</p>` : ""}

      <h2>Adaugă o componentă</h2>
      <form class="form" method="post" action="/productie/retete/${p.id}/adauga" style="max-width:640px">
        <label class="field"><span>Componenta</span>
          <select name="componenta_id" required>
            ${candidati
              .map((c) => `<option value="${c.id}">${esc(c.denumire)}${um(c) ? " · " + esc(um(c)) : ""}${Number(c.pret_achizitie) > 0 ? " · " + Number(c.pret_achizitie).toLocaleString("ro-RO", { maximumFractionDigits: 4 }) + " lei" : " · fără preț"}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field"><span>Cantitate pe o bucată de produs finit</span>
          <input type="number" name="cantitate" step="0.000001" min="0" required placeholder="ex. 0,85">
          <span class="ajutor">Dacă știi consumul pe lot, împarte-l la câte bucăți au ieșit din lot.</span>
        </label>
        <div class="form-actions"><button class="btn" type="submit">Adaugă în rețetă</button></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Rețeta: ${p.denumire}`, active: "/productie/retete", body }));
  });

  router.post("/productie/retete/:id/adauga", async (ctx) => {
    const produsId = Number(ctx.params.id);
    const compId = Number(ctx.body.componenta_id);
    const cant = nr(ctx.body.cantitate);
    const inapoi = (m) => redirect(ctx.res, `/productie/retete/${produsId}` + (m ? "?eroare=" + encodeURIComponent(m) : ""));
    if (!compId || !(cant > 0)) return inapoi("Alege componenta și scrie o cantitate mai mare ca zero.");
    if (compId === produsId) return inapoi("Un produs nu poate intra în propria rețetă.");

    const existent = await db.prepare("SELECT id FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").get(produsId, compId);
    if (existent) await db.prepare("UPDATE retete_componente SET cantitate = ? WHERE id = ?").run(cant, existent.id);
    else await db.prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)").run(produsId, compId, cant);

    // Costul se recalculează imediat: rețeta abia schimbată trebuie să se vadă
    // în marjă de la următoarea pagină, nu de la următorul import.
    await cost.recalculeazaRetete();
    return inapoi("");
  });

  // ---- Necesarul de materie primă al unei comenzi -------------------------
  // Rețeta spune ce intră într-o bucată; comanda spune câte bucăți. Din
  // înmulțirea lor iese lista de cules din depozit. Pagina asta NU scoate
  // nimic — arată doar ce trebuie luat, de pe care paleți (cei mai vechi
  // întâi, ca la FIFO) și ce lipsește. Scoaterea rămâne unde a fost mereu:
  // în ecranul de ieșire marfă, apăsată de omul din depozit.
  router.get("/productie/:id/necesar", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const c = await db
      .prepare(
        `SELECT c.*, pr.denumire AS produs_denumire, pr.unitate_masura AS produs_um, p.nume AS partener_nume
           FROM comenzi_productie c
           LEFT JOIN produse pr ON pr.id = c.produs_id
           LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE c.id = ?`
      )
      .get(ctx.params.id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsită", active: "/productie", body: "<p>Comanda nu există.</p>" }));

    const cant = Number(String(c.cantitate || "").replace(/[^\d.,-]/g, "").replace(",", ".")) || 0;
    const capTabel = `
      <div class="toolbar">
        <a class="btn secondary" href="/productie/${c.id}">← Înapoi la comandă</a>
        ${c.produs_id ? `<a class="btn secondary" href="/productie/retete/${c.produs_id}">Rețeta produsului</a>` : ""}
        <a class="btn secondary" href="/stocuri/ct-park/iesire">Ieșire marfă din depozit</a>
      </div>
      <h1 style="margin:6px 0 2px">Necesar de materie primă — comanda ${esc(c.numar || c.id)}</h1>
      <p class="mic" style="margin:0 0 14px">
        ${esc(c.produs_denumire || c.tip_produs || "produs nespecificat")} ·
        ${cant ? esc(String(cant)) : "?"} ${esc(c.um || c.produs_um || "buc")}
        ${c.partener_nume || c.client_text ? ` · pentru ${esc(c.partener_nume || c.client_text)}` : ""}
      </p>`;

    const gol = (mesaj) =>
      send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: `Necesar comanda ${c.numar || c.id}`,
          active: "/productie",
          body: `${capTabel}<div class="card"><p style="margin:0">${mesaj}</p></div>`,
        })
      );

    if (!c.produs_id) return gol('Comanda nu e legată de un produs din catalog, deci n-are rețetă. Leag-o din <a href="/productie/' + c.id + '">pagina comenzii</a>.');
    if (!cant) return gol("Comanda n-are o cantitate din care să se poată calcula necesarul.");

    const d = await cost.detaliuReteta(c.produs_id);
    if (!d.linii.length) return gol(`Produsul <a href="/productie/retete/${c.produs_id}">${esc(c.produs_denumire || "")}</a> n-are încă rețetă. Scrie-o și necesarul apare singur.`);

    // Ce e în depozit din fiecare componentă, paletă cu paletă, cele mai vechi
    // întâi — exact ordinea în care ar trebui scoase.
    const compIds = d.linii.map((l) => Number(l.componenta_id)).filter(Boolean);
    const paleti = compIds.length
      ? await db
          .prepare(
            `SELECT p.id, p.produs_id, p.cantitate, p.um, p.data_intrare, p.pret_unitar,
                    COALESCE(pr.denumire, p.produs_text) AS marfa
               FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
              WHERE p.data_iesire IS NULL AND p.produs_id IN (${compIds.map(() => "?").join(",")})
              ORDER BY p.produs_id, p.data_intrare ASC, p.id ASC`
          )
          .all(...compIds)
          .catch(() => [])
      : [];
    const peProdus = new Map();
    for (const p of paleti) {
      const k = Number(p.produs_id);
      if (!peProdus.has(k)) peProdus.set(k, []);
      peProdus.get(k).push(p);
    }

    let totalCost = 0;
    let lipsuri = 0;
    const randuri = d.linii.map((l) => {
      const nevoie = Number(l.cantitate) * cant;
      const stoc = peProdus.get(Number(l.componenta_id)) || [];
      // Paletele de luat: cele mai vechi, până se acoperă nevoia. Paletul se ia
      // întreg — depozitul nu ține fracțiuni de paletă — deci ultimul depășește
      // de obicei nevoia, și spunem cât rămâne.
      let strans = 0;
      const luate = [];
      for (const p of stoc) {
        if (strans >= nevoie) break;
        luate.push(p);
        strans += Number(p.cantitate) || 0;
      }
      const inStoc = stoc.reduce((s2, p) => s2 + (Number(p.cantitate) || 0), 0);
      const lipsa = Math.max(0, nevoie - inStoc);
      if (lipsa > 0) lipsuri++;
      totalCost += nevoie * Number(l.cost_unitar || 0);
      const nrf = (x) => (Math.round(x * 1000) / 1000).toLocaleString("ro-RO");
      return [
        `<a href="/productie/retete/${l.componenta_id}">${esc(l.denumire)}</a>`,
        `${nrf(Number(l.cantitate))} ${esc(l.um || "")}`,
        `<b>${nrf(nevoie)}</b> ${esc(l.um || "")}`,
        `${nrf(inStoc)} ${esc(l.um || "")}<br><span class="mic">${stoc.length} ${stoc.length === 1 ? "paletă" : "palete"}</span>`,
        lipsa > 0
          ? `<span class="badge rosu">lipsesc ${nrf(lipsa)} ${esc(l.um || "")}</span>`
          : `<span class="badge verde">acoperit</span>`,
        luate.length
          ? `${luate.map((p) => `<a href="/stocuri/ct-park/paleti?q=${p.id}">#${p.id}</a><span class="mic"> · ${nrf(Number(p.cantitate) || 0)} · ${esc(String(p.data_intrare || "").slice(0, 10))}</span>`).join("<br>")}
             ${strans > nevoie ? `<br><span class="mic">rămân ${nrf(strans - nevoie)} ${esc(l.um || "")}</span>` : ""}`
          : '<span class="mic">nimic în depozit</span>',
        Number(l.cost_unitar) > 0 ? money(nevoie * Number(l.cost_unitar)) : '<span class="mic">fără cost</span>',
      ];
    });

    const body = `
      ${capTabel}
      <div class="cards">
        <div class="card"><div class="label">Componente în rețetă</div><div class="value">${d.linii.length}</div></div>
        <div class="card"><div class="label">Nu se acoperă din depozit</div>
          <div class="value" style="color:${lipsuri ? "var(--danger)" : "inherit"}">${lipsuri}</div></div>
        <div class="card"><div class="label">Cost materie primă</div><div class="value">${money(totalCost)}</div>
          <div class="mic">${d.lipsa ? `${d.lipsa} ${d.lipsa === 1 ? "componentă n-are" : "componente n-au"} cost — e o limită de jos` : "toate componentele au cost"}</div></div>
      </div>
      ${table(
        ["Componentă", "Pe bucată", "Necesar", "În depozit", "Acoperire", "Palete de luat, FIFO", "Cost"],
        randuri
      )}
      <p class="explic">
        Lista asta <b>nu scoate nimic</b> din depozit — doar spune ce trebuie luat. Scoaterea se face din
        <a href="/stocuri/ct-park/iesire">Depozit → Ieșire marfă</a>, cu destinația <b>producție</b>, bifând paletele de mai sus.
        Paletele se scot întregi, așa că la ultima paletă rămâne de obicei o diferență — e scrisă pe rândul ei.
      </p>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Necesar comanda ${c.numar || c.id}`, active: "/productie", body }));
  });

  router.post("/productie/retete/:id/sterge", async (ctx) => {
    const produsId = Number(ctx.params.id);
    const compId = Number(ctx.body.componenta_id);
    if (compId) await db.prepare("DELETE FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").run(produsId, compId);
    await cost.recalculeazaRetete();
    return redirect(ctx.res, `/productie/retete/${produsId}`);
  });
}

module.exports = { register };
