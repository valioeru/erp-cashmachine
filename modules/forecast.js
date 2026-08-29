"use strict";
// Depozit · Forecast aprovizionări.
//
// Întrebarea la care răspunde pagina: ce trebuie cumpărat luna viitoare ca să
// nu stăm în loc. Nu ghicește nimic — se uită la ce s-a vândut în ultimele
// luni și presupune că ce s-a vândut lună de lună se va vinde și mai departe.
//
// Recurența e cheia. Un produs vândut în șase luni din șase e o certitudine;
// unul vândut o singură dată, acum patru luni, e o întâmplare. Le arătăm pe
// amândouă, dar cu recurența la vedere, ca să nu comanzi pe baza unei
// întâmplări. Media lunară se împarte mereu la toate lunile din fereastră, nu
// doar la cele cu vânzări — altfel un produs vândut o dată ar părea că se
// vinde constant.
//
// Materia primă nu se prognozează separat: se deduce din rețete. Dacă avem
// nevoie de 10.000 de saci, avem nevoie și de folia din care se fac. Așa,
// cifrele de pe cele două tabele nu se pot contrazice.
const db = require("../lib/db");
const { SUB_STOC_PRODUS } = require("../lib/stoc");
const { esc, layout, table } = require("../lib/render");
const { send } = require("../lib/router");
const { subnavDepozit } = require("../lib/render");

const LUNI_IMPLICIT = 6;
const ORIZONT_IMPLICIT = 1;
const LUNI_MAX = 24;
const ORIZONT_MAX = 6;

const nr = (v) => Number(v || 0);

// Unitatea de măsură se lipește de cifră doar dacă chiar e o unitate. În
// catalog s-au strecurat produse la care în locul unității stă toată denumirea
// articolului — „4.533 Plicuri autoadezive AWB C5 CM" nu se citește ca o
// cantitate, se citește ca o greșeală.
function unitate(um) {
  const u = String(um || "").trim();
  return u && u.length <= 10 ? " " + esc(u) : "";
}

function cant(v, um) {
  const n = nr(v);
  const zecimale = Math.abs(n) < 100 && Math.abs(n % 1) > 0.0001 ? 2 : 0;
  return n.toLocaleString("ro-RO", { minimumFractionDigits: zecimale, maximumFractionDigits: zecimale }) + unitate(um);
}

// Prima zi a lunii de acum N luni. Fereastra începe la început de lună, ca
// „ultimele 6 luni" să însemne șase luni întregi, nu cinci și un ciot.
function inceputFereastra(luni) {
  const d = new Date();
  const l = new Date(d.getFullYear(), d.getMonth() - (luni - 1), 1);
  return l.toISOString().slice(0, 10);
}

async function vanzariPeProdus(deLa, luni) {
  const randuri = await db
    .prepare(
      `SELECT fl.produs_id, pr.denumire, pr.cod, pr.unitate_masura, pr.stoc_minim,
              SUM(fl.cantitate) AS cantitate,
              COUNT(DISTINCT SUBSTR(f.data_emiterii, 1, 7)) AS luni_cu_vanzari,
              COUNT(DISTINCT f.id) AS facturi,
              MAX(SUBSTR(f.data_emiterii, 1, 10)) AS ultima_vanzare
         FROM facturi_linii fl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
         JOIN produse pr ON pr.id = fl.produs_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna')
          AND COALESCE(f.intercompany, 0) = 0
          AND fl.cantitate > 0 AND SUBSTR(f.data_emiterii, 1, 10) >= ?
        GROUP BY fl.produs_id, pr.denumire, pr.cod, pr.unitate_masura, pr.stoc_minim`
    )
    .all(deLa);
  return randuri.map((r) => ({
    ...r,
    medie_lunara: nr(r.cantitate) / luni,
    recurenta: nr(r.luni_cu_vanzari) / luni,
  }));
}

async function stocuri() {
  const randuri = await db.prepare(`SELECT produs_id, stoc FROM ${SUB_STOC_PRODUS} s`).all();
  const m = new Map();
  for (const r of randuri) m.set(Number(r.produs_id), nr(r.stoc));
  return m;
}

async function retete() {
  return db
    .prepare(
      `SELECT rc.produs_id, rc.componenta_id, rc.cantitate,
              c.denumire, c.cod, c.unitate_masura
         FROM retete_componente rc
         JOIN produse c ON c.id = rc.componenta_id`
    )
    .all();
}

function register(router) {
  router.get("/depozit/forecast", async (ctx) => {
    const q = ctx.query || {};
    const luni = Math.min(LUNI_MAX, Math.max(1, parseInt(q.luni, 10) || LUNI_IMPLICIT));
    const orizont = Math.min(ORIZONT_MAX, Math.max(1, parseInt(q.orizont, 10) || ORIZONT_IMPLICIT));
    const minRecurenta = q.recurenta === "toate" ? 0 : Number(q.recurenta) || 0.5;
    const deLa = inceputFereastra(luni);

    const vanzari = await vanzariPeProdus(deLa, luni);
    const stoc = await stocuri();
    const liniiReteta = await retete();

    const areReteta = new Set(liniiReteta.map((r) => Number(r.produs_id)));
    const nrRetete = areReteta.size;

    // Ce se cere de la fiecare produs în orizontul ales. Recurența sub prag
    // nu dispare din listă, dar nu trage după ea comenzi de materie primă:
    // n-are rost să cumperi folie pentru o vânzare care s-a întâmplat o dată.
    const cerere = vanzari
      .map((v) => {
        const necesar = v.medie_lunara * orizont;
        const stocul = stoc.get(Number(v.produs_id)) || 0;
        return { ...v, necesar, stoc: stocul, diferenta: stocul - necesar, sigur: v.recurenta >= minRecurenta };
      })
      .filter((v) => v.necesar > 0);

    // Materia primă: explodăm cererea prin rețete. Un component poate intra în
    // mai multe produse, de aceea se adună, și ținem minte din ce vine, ca să
    // se poată verifica cifra.
    const peComponenta = new Map();
    for (const r of liniiReteta) {
      const produs = cerere.find((c) => Number(c.produs_id) === Number(r.produs_id));
      if (!produs || !produs.sigur) continue;
      const cheie = Number(r.componenta_id);
      if (!peComponenta.has(cheie)) {
        peComponenta.set(cheie, {
          componenta_id: cheie,
          denumire: r.denumire,
          cod: r.cod,
          unitate_masura: r.unitate_masura,
          necesar: 0,
          pentru: [],
        });
      }
      const c = peComponenta.get(cheie);
      const cantitate = nr(r.cantitate) * produs.necesar;
      c.necesar += cantitate;
      if (c.pentru.length < 4) c.pentru.push(produs.denumire);
    }

    const materii = [...peComponenta.values()]
      .map((c) => {
        const stocul = stoc.get(c.componenta_id) || 0;
        return { ...c, stoc: stocul, diferenta: stocul - c.necesar };
      })
      .sort((a, b) => a.diferenta - b.diferenta);

    const produseFinite = cerere
      .filter((c) => areReteta.has(Number(c.produs_id)))
      .sort((a, b) => a.diferenta - b.diferenta);
    const marfaCumparata = cerere
      .filter((c) => !areReteta.has(Number(c.produs_id)))
      .sort((a, b) => a.diferenta - b.diferenta);

    const lipsa = (d) =>
      d < 0
        ? `<strong style="color:var(--danger)">${cant(d)}</strong>`
        : `<span style="color:var(--success)">+${cant(d)}</span>`;

    const semnRecurenta = (v) => {
      const p = Math.round(v.recurenta * 100);
      const culoare = v.recurenta >= 0.8 ? "var(--success)" : v.recurenta >= 0.5 ? "var(--warn)" : "var(--text-muted)";
      return `<span style="color:${culoare}">${v.luni_cu_vanzari}/${luni} luni · ${p}%</span>`;
    };

    const randProdus = (v) => [
      `<a href="/produse/${v.produs_id}">${esc(v.denumire)}</a>${v.cod ? ` <span style="color:var(--text-muted)">(${esc(v.cod)})</span>` : ""}`,
      semnRecurenta(v),
      cant(v.medie_lunara, v.unitate_masura),
      cant(v.necesar, v.unitate_masura),
      cant(v.stoc, v.unitate_masura),
      lipsa(v.diferenta),
      esc(v.ultima_vanzare || "—"),
    ];

    const capeteProdus = ["Produs", "Recurență", "Medie / lună", `Necesar ${orizont} ${orizont === 1 ? "lună" : "luni"}`, "Stoc curent", "Diferență estimată", "Ultima vânzare"];

    const selector = (nume, valoare, optiuni) =>
      `<select name="${nume}" onchange="this.form.submit()">${optiuni
        .map(([v, t]) => `<option value="${v}"${String(valoare) === String(v) ? " selected" : ""}>${esc(t)}</option>`)
        .join("")}</select>`;

    const deComandatMaterii = materii.filter((m) => m.diferenta < 0).length;
    const deComandatProduse = [...produseFinite, ...marfaCumparata].filter((p) => p.diferenta < 0).length;

    const body = `
      ${subnavDepozit("/depozit/forecast", ctx.user)}

      <p style="color:var(--text-muted);font-size:13px;max-width:880px">
        Se uită la ce s-a vândut în ultimele ${luni} luni și presupune că ce s-a vândut constant se va
        vinde și mai departe. Media lunară se împarte la toate lunile din fereastră, nu doar la cele
        cu vânzări, iar recurența arată în câte luni din ${luni} s-a vândut efectiv — un produs cu
        ${luni}/${luni} e o certitudine, unul cu 1/${luni} e o întâmplare. Materia primă nu se
        prognozează separat: se deduce din rețetele produselor cerute, ca cele două tabele să nu se
        poată contrazice.
      </p>

      <form method="get" action="/depozit/forecast" class="inline-form" style="gap:12px;flex-wrap:wrap;margin:14px 0">
        <label style="font-size:13px;color:var(--text-muted)">Istoric
          ${selector("luni", luni, [[3, "ultimele 3 luni"], [6, "ultimele 6 luni"], [12, "ultimele 12 luni"], [24, "ultimele 24 luni"]])}
        </label>
        <label style="font-size:13px;color:var(--text-muted)">Acoperim
          ${selector("orizont", orizont, [[1, "1 lună"], [2, "2 luni"], [3, "3 luni"], [6, "6 luni"]])}
        </label>
        <label style="font-size:13px;color:var(--text-muted)">Recurență minimă
          ${selector("recurenta", q.recurenta === "toate" ? "toate" : String(minRecurenta), [
            [0.8, "peste 80% din luni"],
            [0.5, "peste jumătate din luni"],
            [0.25, "peste un sfert din luni"],
            ["toate", "toate, oricât de rar"],
          ])}
        </label>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Materii prime de aprovizionat</div>
          <div class="value" style="color:${deComandatMaterii ? "var(--danger)" : "var(--success)"}">${deComandatMaterii}</div>
          <div style="font-size:12px;color:var(--text-muted)">din ${materii.length} care intră în rețete</div></div>
        <div class="card"><div class="label">Produse de completat</div>
          <div class="value" style="color:${deComandatProduse ? "var(--danger)" : "var(--success)"}">${deComandatProduse}</div>
          <div style="font-size:12px;color:var(--text-muted)">din ${cerere.length} vândute în perioadă</div></div>
      </div>

      <h2>Materie primă de aprovizionat</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">
        Dedusă din rețetele produselor cu recurență peste prag. „Diferență" negativă înseamnă că nu
        avem cât ne trebuie — exact atâta lipsește.
      </p>
      ${
        materii.length
          ? ""
          : `<div class="card" style="border-left:4px solid var(--warn);margin-bottom:12px">
               <p style="margin:0;font-size:13px">
                 Niciun produs vândut în perioadă n-are rețetă în ERP, deci n-avem din ce deduce materia primă.
                 Rețetele se construiesc din perechile bon de consum + bon de predare aduse din SmartBill:
                 ${nrRetete} produse au rețetă, dar niciunul dintre ele nu apare pe facturile din ultimele ${luni} luni.
                 Cel mai probabil produsul finit e înregistrat cu alt cod la vânzare decât la producție.
               </p>
             </div>`
      }
      ${table(
        ["Materie primă", "Intră în", "Necesar", "Stoc curent", "Diferență estimată"],
        materii.map((m) => [
          `<a href="/produse/${m.componenta_id}">${esc(m.denumire)}</a>${m.cod ? ` <span style="color:var(--text-muted)">(${esc(m.cod)})</span>` : ""}`,
          `<span style="font-size:12px;color:var(--text-muted)">${esc(m.pentru.join(", "))}</span>`,
          cant(m.necesar, m.unitate_masura),
          cant(m.stoc, m.unitate_masura),
          lipsa(m.diferenta),
        ])
      )}

      <h2 style="margin-top:26px">Produse finite de făcut</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">
        Produsele care au rețetă — se fac în casă, deci „necesarul" e comandă de producție, nu de cumpărare.
      </p>
      ${table(capeteProdus, produseFinite.map(randProdus))}

      <h2 style="margin-top:26px">Marfă de cumpărat</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">
        Produsele fără rețetă: se cumpără gata făcute.
      </p>
      ${table(capeteProdus, marfaCumparata.slice(0, 200).map(randProdus))}
      ${
        marfaCumparata.length > 200
          ? `<p style="color:var(--text-muted);font-size:13px">Se arată primele 200 din ${marfaCumparata.length}, cele mai lipsă întâi.</p>`
          : ""
      }
    `;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Forecast aprovizionări", active: "/depozit/forecast", body }));
  });
}

module.exports = { register };
