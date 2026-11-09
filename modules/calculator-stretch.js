"use strict";
// Calculatorul de cost al rolei stretch făcute din jumbo, lângă celelalte
// calculatoare (preț pe categorie, plicuri AWB, pungi, cutii). Formulele sunt
// în lib/stretch-cost.js, aceleași ca în Excelul primit de la Vali pe
// 09.11.2026; aici e pagina: intrările, prețul jumbo din CT-Park și
// parametrii de producție (salariu, energie, core-uri, mașini), pe care îi
// schimbă doar administratorul.
//
// Ca la celelalte calculatoare, intrările stau în adresa paginii: un calcul
// se poate trimite ca link, fără să se salveze nimic.

const db = require("../lib/db");
const { esc, layout, subnavCrm, selectorCalculator } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const SC = require("../lib/stretch-cost");

const CALE = "/calculator/stretch";
const CHEIE = "stretch_cost_asumptii";

// „14,4" sau „14.4" → 14,4. Câmpul gol nu e zero: e „nu s-a scris nimic", deci
// rămâne valoarea de dinainte.
const numar = (v) => {
  const s = String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".");
  if (s === "") return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
};
const bani = (v, z = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("ro-RO", { minimumFractionDigits: z, maximumFractionDigits: z }) : "—");
const cifra = (v, z = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("ro-RO", { maximumFractionDigits: z }) : "—");

// ---- Parametrii salvați ---------------------------------------------------
async function citesteAsumptii() {
  let salvat = null;
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(CHEIE);
    salvat = r && r.valoare ? JSON.parse(r.valoare) : null;
  } catch (e) {
    salvat = null;
  }
  const p = Object.assign({}, SC.PARAMETRI);
  for (const k of Object.keys(SC.PARAMETRI)) {
    const v = salvat && salvat.parametri ? numar(salvat.parametri[k]) : NaN;
    if (Number.isFinite(v)) p[k] = v;
  }
  const din = (lista, salvate, campuri) =>
    lista.map((x) => {
      const s = (salvate || []).find((y) => y && y.cheie === x.cheie) || {};
      const o = Object.assign({}, x);
      for (const c of campuri) {
        const v = numar(s[c]);
        if (Number.isFinite(v)) o[c] = v;
      }
      return o;
    });
  return {
    parametri: p,
    core: din(SC.CORE, salvat && salvat.core, ["pret", "kg"]),
    masini: din(SC.MASINI, salvat && salvat.masini, ["viteza", "kw", "accel"]),
    la: salvat && salvat.la,
    de: salvat && salvat.de,
  };
}

async function scrieAsumptii(b, user) {
  const acum = await citesteAsumptii();
  const val = (brut, vechi) => {
    const v = numar(brut);
    return Number.isFinite(v) && v >= 0 ? v : vechi;
  };
  const parametri = {};
  for (const k of Object.keys(SC.PARAMETRI)) parametri[k] = val(b["p_" + k], acum.parametri[k]);
  const core = acum.core.map((c) => ({ cheie: c.cheie, pret: val(b[`c_${c.cheie}_pret`], c.pret), kg: val(b[`c_${c.cheie}_kg`], c.kg) }));
  const masini = acum.masini.map((m) => ({
    cheie: m.cheie,
    viteza: val(b[`m_${m.cheie}_viteza`], m.viteza),
    kw: val(b[`m_${m.cheie}_kw`], m.kw),
    accel: val(b[`m_${m.cheie}_accel`], m.accel),
  }));
  const j = JSON.stringify({
    parametri,
    core,
    masini,
    la: new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 16),
    de: (user && user.nume) || null,
  });
  const t = new Date().toISOString();
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(CHEIE).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(j, t, CHEIE);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(CHEIE, j, t);
}

// ---- Jumbo-ul stretch din CT-Park -----------------------------------------
// Același stoc ca pe pagina de stocuri (lib/stoc-produse.js): liniile de pe
// paleții încă în depozit, paleții vechi fără linii și marfa din recepțiile
// finalizate care n-a ajuns pe raft. Din el, ce are „stretch" și „jumbo" în
// denumire sau cod — așa rămâne pe dinafară banda adezivă jumbo.
//
// Pe produse: câte kg sunt și cât costă kilogramul, media ponderată a ce are
// preț. Ce n-are preț intră în kilograme, nu și în medie. Ce e în altă
// unitate decât kg (buc, role) nu se adună la kilograme — se spune doar că
// există; unitatea goală se ia drept kg, cum se vinde jumbo-ul.
async function jumboDinStoc() {
  const { LINIE_DESCHISA } = require("../lib/gata-productie");
  const { normUm } = require("../lib/stoc-produse");
  const text = "LOWER(COALESCE(denumire, '') || ' ' || COALESCE(cod, ''))";
  const randuri = await db
    .prepare(
      `SELECT * FROM (
         SELECT pl.produs_id, COALESCE(pr.denumire, pl.produs_text, p.produs_text) AS denumire,
                COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod, COALESCE(pl.um, p.um) AS um,
                pl.cantitate, pl.pret_unitar
           FROM ct_palet_linii pl
           JOIN ct_paleti p ON p.id = pl.palet_id
           LEFT JOIN produse pr ON pr.id = pl.produs_id
          WHERE p.data_iesire IS NULL
         UNION ALL
         SELECT p.produs_id, COALESCE(pr.denumire, p.produs_text),
                COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat), p.um,
                p.cantitate, p.pret_unitar
           FROM ct_paleti p
           LEFT JOIN produse pr ON pr.id = p.produs_id
          WHERE p.data_iesire IS NULL
            AND NOT EXISTS (SELECT 1 FROM ct_palet_linii x WHERE x.palet_id = p.id)
         UNION ALL
         SELECT rl.produs_id, COALESCE(pr.denumire, rl.produs_text),
                COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat), rl.um,
                COALESCE(rl.cantitate_primita, 0) - COALESCE((SELECT SUM(px.cantitate) FROM ct_paleti px WHERE px.receptie_linie_id = rl.id), 0),
                rl.pret_unitar
           FROM receptii_linii rl
           JOIN receptii r ON r.id = rl.receptie_id
           LEFT JOIN produse pr ON pr.id = rl.produs_id
          WHERE r.stare = 'finalizata' AND rl.stare = 'primita' AND COALESCE(rl.conditie, 'bun') = 'bun'
            AND ${LINIE_DESCHISA}
       ) t
       WHERE cantitate > 0
         AND (${text} LIKE '%stretch%' OR ${text} LIKE '%strech%')
         AND ${text} LIKE '%jumbo%'`
    )
    .all()
    .catch((e) => {
      console.error("[calculator stretch] stocul jumbo din CT-Park nu s-a citit:", e.message);
      return [];
    });

  const pe = new Map();
  for (const r of randuri) {
    const cheie = r.produs_id ? String(r.produs_id) : "t:" + String(r.denumire || "").trim().toLowerCase();
    let p = pe.get(cheie);
    if (!p) {
      p = { cheie, denumire: r.denumire || "(fără denumire)", cod: r.cod || "", kg: 0, kgCuPret: 0, valoare: 0, alteUm: {} };
      pe.set(cheie, p);
    }
    const q = Number(r.cantitate) || 0;
    const um = normUm(r.um);
    if (um && um !== "kg") {
      p.alteUm[um] = (p.alteUm[um] || 0) + q;
      continue;
    }
    p.kg += q;
    const pu = Number(r.pret_unitar) || 0;
    if (pu > 0) {
      p.kgCuPret += q;
      p.valoare += q * pu;
    }
  }
  const produse = [...pe.values()]
    .map((p) => Object.assign(p, { pret: p.kgCuPret > 0 ? p.valoare / p.kgCuPret : 0 }))
    .sort((a, b) => a.denumire.localeCompare(b.denumire, "ro"));
  const kgCuPret = produse.reduce((s, p) => s + p.kgCuPret, 0);
  const valoare = produse.reduce((s, p) => s + p.valoare, 0);
  return { produse, medie: { pret: kgCuPret > 0 ? valoare / kgCuPret : 0, kgCuPret, kg: produse.reduce((s, p) => s + p.kg, 0) } };
}

// Cursul EUR de la BNR, cel mai nou din ERP. Fără el, cel din foaie (5,35).
async function cursEur() {
  const r = await db
    .prepare("SELECT valoare, data FROM cursuri_bnr WHERE moneda = 'EUR' ORDER BY data DESC LIMIT 1")
    .get()
    .catch(() => null);
  return r && Number(r.valoare) > 0 ? { curs: Number(r.valoare), data: String(r.data).slice(0, 10) } : { curs: SC.INTRARI.curs, data: null };
}

// Intrările, din adresa paginii, peste valorile implicite.
function intrari(q, curs) {
  const x = Object.assign({}, SC.INTRARI, { curs });
  for (const k of ["kg", "grosime", "latime", "pret_eur", "curs", "jumbo_teoretic", "jumbo_util", "alte", "adaos", "role"]) {
    const v = numar(q[k]);
    if (q[k] !== undefined && q[k] !== "" && Number.isFinite(v) && v >= 0) x[k] = v;
  }
  if (SC.CORE.some((c) => c.cheie === q.core)) x.core = q.core;
  if (SC.MASINI.some((m) => m.cheie === q.masina)) x.masina = q.masina;
  if (["manual", "medie", "produs"].includes(q.sursa)) x.sursa = q.sursa;
  if (q.produs_id) x.produs_id = String(q.produs_id).slice(0, 200);
  if (String(q.intregi || "").toUpperCase() === "DA") x.intregi = "DA";
  return x;
}

function pagina(ctx, x, a, stoc, curs, r, pret) {
  const eAdmin = Boolean(ctx.user && ctx.user.rol === "admin");
  const camp = (nume, eticheta, valoare, unitate, extra = "") =>
    `<label class="field"><span>${eticheta}${unitate ? ` <span class="mic">${unitate}</span>` : ""}</span><input name="${nume}" inputmode="decimal" value="${esc(String(valoare).replace(".", ","))}"${extra}></label>`;
  const optiuni = (lista, ales) => lista.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(ales) ? " selected" : ""}>${esc(t)}</option>`).join("");
  const randuri = (lista) =>
    `<table class="table"><tbody>${lista
      .map(([t, v, mic, tare]) => `<tr${tare ? ' style="font-weight:600"' : ""}><td>${t}</td><td style="text-align:right;white-space:nowrap">${v}</td><td class="mic" style="color:var(--text-muted)">${mic || ""}</td></tr>`)
      .join("")}</tbody></table>`;
  const coreAles = a.core.find((c) => c.cheie === x.core);
  const masinaAleasa = a.masini.find((m) => m.cheie === x.masina);

  const formular = `
    <form method="get" action="${CALE}" class="form" style="max-width:1100px">
      <div class="pungi-rapid">
        ${camp("kg", "Greutate cerută de client", x.kg, "kg net, fără core")}
        ${camp("grosime", "Grosime folie", x.grosime, "µm")}
        ${camp("latime", "Lățime rolă", x.latime, "mm")}
        <label class="field"><span>Tip core</span><select name="core">${optiuni(a.core.map((c) => [c.cheie, `${c.nume} — ${cifra(c.pret)} lei, ${cifra(c.kg, 3)} kg`]), x.core)}</select></label>
        <label class="field"><span>Mașină</span><select name="masina">${optiuni(a.masini.map((m) => [m.cheie, `${m.nume} (${m.utilaj}) — ${cifra(m.viteza, 0)} m/min`]), x.masina)}</select></label>
        <label class="field"><span>Prețul jumbo</span><select name="sursa">${optiuni(
          [
            ["manual", "scris de mână, EUR/kg"],
            ["medie", `media stocului CT-Park${stoc.medie.pret > 0 ? ` — ${bani(stoc.medie.pret)} lei/kg` : " (fără prețuri)"}`],
            ["produs", "un jumbo ales din stoc"],
          ],
          x.sursa
        )}</select></label>
        ${camp("pret_eur", "Preț jumbo, de mână", x.pret_eur, "EUR/kg")}
        <label class="field"><span>Jumbo din stoc <span class="mic">la „un jumbo ales”</span></span><select name="produs_id"><option value="">— alege —</option>${optiuni(
          stoc.produse.map((p) => {
            const alte = Object.entries(p.alteUm || {}).map(([u, q]) => `${cifra(q, 1)} ${u}`);
            return [
              p.cheie,
              `${p.denumire}${p.cod ? " (" + p.cod + ")" : ""} — ${cifra(p.kg, 1)} kg · ${p.pret > 0 ? bani(p.pret) + " lei/kg" : "fără preț"}${alte.length ? ` · plus ${alte.join(", ")}, nesocotite` : ""}`,
            ];
          }),
          x.produs_id
        )}</select></label>
        ${camp("curs", "Curs EUR", x.curs, "lei")}
        ${camp("jumbo_teoretic", "Jumbo teoretic / plătit", x.jumbo_teoretic, "kg")}
        ${camp("jumbo_util", "Jumbo util / real", x.jumbo_util, "kg")}
        ${camp("alte", "Alte costuri — ambalare, transport", x.alte, "lei/rolă")}
        ${camp("adaos", "Adaos peste cost", x.adaos, "%")}
        ${camp("role", "Cantitate comandă", x.role, "role")}
        <label class="field"><span>Doar role întregi din jumbo? <span class="mic">DA = restul e capăt pierdut</span></span><select name="intregi">${optiuni([["NU", "NU"], ["DA", "DA"]], x.intregi)}</select></label>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Calculează</button> <a class="btn secondary" href="${CALE}">Golește</a></div>
    </form>`;

  const carduri = `
    <div class="cards">
      <div class="card"><div class="label">Cost pe rolă</div><div class="value">${bani(r.costRola)} lei</div><div class="mic" style="color:var(--text-muted)">${bani(r.costRolaEur)} EUR · ${bani(r.costPeKg)} lei/kg livrat</div></div>
      <div class="card"><div class="label">Preț de vânzare pe rolă</div><div class="value">${bani(r.pretRola)} lei</div><div class="mic" style="color:var(--text-muted)">${bani(r.pretRolaEur)} EUR · adaos ${cifra(x.adaos)}%</div></div>
      <div class="card"><div class="label">Productivitate</div><div class="value">${cifra(r.rolePeOra, 1)} role/oră</div><div class="mic" style="color:var(--text-muted)">ciclu ${cifra(r.ciclu, 1)} s pe rolă</div></div>
      <div class="card"><div class="label">Comanda (${cifra(x.role, 0)} ${Number(x.role) === 1 ? "rolă" : "role"})</div><div class="value">${bani(r.vanzare)} lei</div><div class="mic" style="color:var(--text-muted)">cost ${bani(r.costTotal)} lei · profit ${bani(r.profit)} lei</div></div>
    </div>`;

  // Avertismentul e roșu de tot, nu verdele obișnuit al mesajelor cu dungă
  // roșie: e o cifră care nu trebuie dată clientului așa cum e.
  const rosu = 'class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)"';
  const avertismente = [
    r.atentie ? `<div ${rosu}>${esc(r.atentie)}.</div>` : "",
    pret.lipsa ? `<div ${rosu}>Prețul jumbo nu se poate lua din stoc: ${esc(pret.text)}. Alege prețul scris de mână sau alt jumbo.</div>` : "",
  ].join("");

  const detalii = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px;max-width:1100px">
      <div>
        <h3 style="margin:6px 0">Prețul materiei prime</h3>
        ${randuri([
          ["Preț stretch folosit", `${bani(r.pretRonKg, 4)} lei/kg`, esc(pret.text)],
          ["", `${bani(r.pretEurKg, 4)} EUR/kg`, ""],
          ["Media stocului CT-Park", stoc.medie.pret > 0 ? `${bani(stoc.medie.pret, 4)} lei/kg` : "—", `din ${cifra(stoc.medie.kgCuPret, 1)} kg cu preț, ${cifra(stoc.medie.kg, 1)} kg jumbo stretch în stoc`],
        ])}
        <h3 style="margin:14px 0 6px">Producție</h3>
        ${randuri([
          ["Lungime folie pe rolă", `${cifra(r.lungime, 1)} m`, "kg ÷ (lățime × grosime × densitate)"],
          ["Viteză mașină", `${cifra(r.viteza, 0)} m/min`, esc(masinaAleasa ? masinaAleasa.nume : "")],
          ["Putere mașină", `${cifra(r.kw, 2)} kW`, ""],
          ["Timp bobinare", `${cifra(r.bobinare, 1)} s/rolă`, ""],
          ["Accelerare + decelerare", `${cifra(r.accel, 0)} s/rolă`, ""],
          ["Manipulare", `${cifra(r.manipulare, 0)} s/rolă`, ""],
          ["Timp ciclu", `${cifra(r.ciclu, 1)} s/rolă`, "", true],
          ["Productivitate", `${cifra(r.rolePeOra, 2)} role/oră`, "", true],
          ["Verificare mașină / produs", r.atentie ? '<span class="badge rosu">ATENȚIE</span>' : '<span class="badge verde">OK</span>', ""],
        ])}
      </div>
      <div>
        <h3 style="margin:6px 0">Cost pe rolă</h3>
        ${randuri([
          ["Cost jumbo (kg teoretice × preț)", `${bani(r.costJumbo)} lei`, ""],
          ["Role dintr-un jumbo", cifra(r.roleDinJumbo, 3), x.intregi === "DA" ? "doar întregi" : ""],
          ["Material pe rolă", `${bani(r.material)} lei`, ""],
          ["Core", `${bani(r.core)} lei`, esc(coreAles ? coreAles.nume : "")],
          ["Electricitate", `${bani(r.electricitate, 4)} lei`, "lei/kWh × kW × timp ciclu"],
          ["Manoperă", `${bani(r.manopera, 4)} lei`, "cost operator/oră × operatori ÷ role/oră"],
          ["Alte costuri", `${bani(r.alte)} lei`, ""],
          ["COST TOTAL PE ROLĂ", `${bani(r.costRola)} lei`, `${bani(r.costRolaEur)} EUR`, true],
          ["PREȚ DE VÂNZARE PE ROLĂ", `${bani(r.pretRola)} lei`, `${bani(r.pretRolaEur)} EUR`, true],
        ])}
        <h3 style="margin:14px 0 6px">Indicatori</h3>
        ${randuri([
          ["Material fără pierderi", `${bani(r.materialFaraPierderi)} lei/rolă`, ""],
          ["Cost pierderi jumbo", `${bani(r.costPierderi)} lei/rolă`, ""],
          ["Pierdere jumbo", `${cifra(r.pierdere * 100, 2)}%`, ""],
          ["Cost pe kg stretch livrat", `${bani(r.costPeKg)} lei/kg`, ""],
          ["Greutate core", `${cifra(r.kgCore, 3)} kg`, ""],
          ["Greutate brută rolă", `${cifra(r.kgBrut, 3)} kg`, ""],
        ])}
        <h3 style="margin:14px 0 6px">Total comandă</h3>
        ${randuri([
          ["Jumbo necesare", `${cifra(r.jumboNecesare, 0)} buc`, ""],
          ["Stretch net livrat", `${cifra(r.netLivrat, 2)} kg`, ""],
          ["Greutate brută comandă", `${cifra(r.brutComanda, 2)} kg`, ""],
          ["Ore mașină necesare", `${cifra(r.oreMasina, 2)} h`, ""],
          ["Cost total", `${bani(r.costTotal)} lei`, ""],
          ["Valoare vânzare", `${bani(r.vanzare)} lei`, `${bani(r.vanzareEur)} EUR`, true],
          ["Profit estimat", `${bani(r.profit)} lei`, "", true],
        ])}
      </div>
    </div>`;

  const p = a.parametri;
  const intrare = (nume, valoare) =>
    eAdmin ? `<input name="${nume}" inputmode="decimal" value="${esc(String(valoare).replace(".", ","))}" style="width:84px;text-align:right">` : esc(cifra(valoare, 3));
  const asumptii = `
    <details id="parametri" style="margin-top:18px;max-width:1100px"${ctx.query.salvat ? " open" : ""}>
      <summary style="cursor:pointer;font-weight:600">Parametri de producție, core-uri și mașini${a.la ? ` <span class="mic" style="color:var(--text-muted);font-weight:400">— schimbați ${esc(a.la)}${a.de ? " de " + esc(a.de) : ""}</span>` : ""}</summary>
      ${ctx.query.salvat ? '<div class="flash">Parametrii s-au salvat.</div>' : ""}
      <form method="post" action="${CALE}/asumptii" class="form" style="margin-top:8px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px">
          <div>
            ${randuri([
              ["Preț energie electrică", intrare("p_energie", p.energie), "lei/kWh — de la Mihai"],
              ["Salariu lunar operator", intrare("p_salariu", p.salariu), "lei — de la Mihai"],
              ["Contribuții angajator peste salariu", intrare("p_contributii", p.contributii), "%"],
              ["Ore lucrate pe lună", intrare("p_ore_luna", p.ore_luna), "ore — de la Mihai"],
              ["Operatori pe mașină", intrare("p_operatori", p.operatori), ""],
              ["Densitate folie", intrare("p_densitate", p.densitate), "g/cm³"],
              ["Timp manipulare pe rolă", intrare("p_manipulare", p.manipulare), "s — estimare, de confirmat"],
            ])}
          </div>
          <div>
            <div style="overflow-x:auto"><table class="table"><thead><tr><th>Core</th><th>Preț (lei)</th><th>Greutate (kg)</th></tr></thead><tbody>
              ${a.core.map((c) => `<tr><td>${esc(c.nume)}<div class="mic" style="color:var(--text-muted)">${esc(c.utilizare)}</div></td><td>${intrare(`c_${c.cheie}_pret`, c.pret)}</td><td>${intrare(`c_${c.cheie}_kg`, c.kg)}</td></tr>`).join("")}
            </tbody></table></div>
            <div style="overflow-x:auto;margin-top:10px"><table class="table"><thead><tr><th>Mașină</th><th>Viteză (m/min)</th><th>Putere (kW)</th><th>Accel. + decel. (s)</th></tr></thead><tbody>
              ${a.masini.map((m) => `<tr><td>${esc(m.nume)}<div class="mic" style="color:var(--text-muted)">${esc(m.utilaj)} · ${esc(m.produse)}</div></td><td>${intrare(`m_${m.cheie}_viteza`, m.viteza)}</td><td>${intrare(`m_${m.cheie}_kw`, m.kw)}</td><td>${intrare(`m_${m.cheie}_accel`, m.accel)}</td></tr>`).join("")}
            </tbody></table></div>
            <p class="mic" style="color:var(--text-muted)">Puterea de 5 kW și timpii de accelerare (5 s, 15 s) sunt de confirmat prin cronometrare.</p>
          </div>
        </div>
        ${eAdmin ? '<div class="form-actions"><button class="btn" type="submit">Salvează parametrii</button></div>' : '<p class="mic" style="color:var(--text-muted)">Parametrii îi schimbă un administrator.</p>'}
      </form>
    </details>
    <p class="mic" style="color:var(--text-muted);max-width:1100px;margin-top:14px">
      Formule: material/rolă = jumbo teoretic × preț ÷ (jumbo util ÷ greutate rolă); timp ciclu = lungime ÷ viteză + accelerare/decelerare + manipulare;
      electricitate = lei/kWh × kW × timp ciclu; manoperă = salariu × (1 + contribuții) ÷ ore pe lună × operatori ÷ role pe oră. Prețuri fără TVA.
    </p>`;

  const body = `
    ${subnavCrm("/calculator", ctx.user)}
    ${selectorCalculator(CALE)}
    <p style="margin:10px 0 12px;color:var(--text-muted);font-size:13px;max-width:900px">
      Costul unei role făcute din jumbo: material, core, electricitate, manoperă. Prețul jumbo îl scrii de mână sau îl iei din stocul
      CT-Park (media paleților cu preț, ori un jumbo anume). Cursul vine de la BNR${curs.data ? ` (${esc(curs.data.split("-").reverse().join("."))})` : ""}.
    </p>
    ${formular}
    ${avertismente}
    ${carduri}
    ${detalii}
    ${asumptii}`;
  return layout({ user: ctx.user, title: "Calculator cost rolă stretch", active: "/crm", body });
}

function register(router) {
  router.get(CALE, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const a = await citesteAsumptii();
    const stoc = await jumboDinStoc();
    const curs = await cursEur();
    const x = intrari(ctx.query || {}, curs.curs);
    const pret = SC.pretFolosit(x, stoc);
    const core = a.core.find((c) => c.cheie === x.core);
    const masina = a.masini.find((m) => m.cheie === x.masina);
    const r = SC.calculeaza(x, a.parametri, core, masina, pret.pret);
    send(ctx.res, 200, pagina(ctx, x, a, stoc, curs, r, pret));
  });

  // Parametrii sunt ai firmei, nu ai unui calcul: doar administratorul.
  router.post(`${CALE}/asumptii`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    await scrieAsumptii(ctx.body || {}, ctx.user);
    return redirect(ctx.res, `${CALE}?salvat=1#parametri`);
  });
}

module.exports = { register, citesteAsumptii, jumboDinStoc, intrari, CALE };
