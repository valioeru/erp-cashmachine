"use strict";
// Clienții mari vs. restul, lună cu lună, fără TVA.
//
// DE CE, în cuvintele lui Vali: „cât am facturat fără TVA la delivery, cargus,
// emag retail, poșta română vs toți ceilalți", de la început de an, pe luni,
// cu sumele ȘI procentele. Întrebarea asta se pune în fiecare lună, iar până
// acum se răspundea la ea cu mâna, din trei rapoarte diferite.
//
// Trei lucruri fac raportul ăsta diferit de „Vânzări":
//
//   1. FĂRĂ TVA. „Vânzări" arată totalul cu TVA — bun pentru încasări, greșit
//      pentru cotă de piață. Aici se însumează cantitate × preț unitar, atât.
//
//   2. EXCLUDERILE LUI. Negru and Negru și BCR Leasing nu sunt vânzare de
//      marfă în sensul ăsta, iar facturile mari de la Warehouse All (peste un
//      prag) sunt altă poveste — o singură factură de câteva sute de mii mută
//      procentele unei luni întregi și ascunde ce s-a întâmplat de fapt.
//      Pragul se poate schimba din adresa paginii, nu e bătut în cuie.
//
//   3. PROCENTELE SE CALCULEAZĂ DUPĂ EXCLUDERI. Altfel n-ar însemna nimic:
//      numitorul ar conține exact ce am scos.
//
// O AVERTIZARE care contează: o factură fără linii valorează zero aici,
// fiindcă suma se face din linii. Dacă sunt multe, cifrele mint în jos — de
// aia pagina numără câte sunt în intervalul ales și o spune sus, cu link către
// verificarea care le repară.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send } = require("../lib/router");

// Numele se compară strâns: fără diacritice, fără punctuație, fără spații.
// „POȘTA ROMÂNĂ S.A." și „Posta Romana SA" sunt aceeași firmă, iar un raport
// care le numără separat e mai rău decât niciun raport.
function strans(nume) {
  return String(nume || "")
    .toLowerCase()
    .replace(/[ăâ]/g, "a")
    .replace(/î/g, "i")
    .replace(/[șş]/g, "s")
    .replace(/[țţ]/g, "t")
    .replace(/[^a-z0-9]+/g, "");
}

// Grupurile cerute. Fiecare are una sau mai multe bucăți de nume: se
// potrivește dacă numele strâns al partenerului conține oricare dintre ele.
//
// Numele din bucăți sunt cele JURIDICE, nu cele de pe camion: eMAG Retail se
// numește Dante International în facturi, iar dacă am căuta „emag" am rata
// exact rândurile care contează.
//
// Delivery și Cargus se numără ÎMPREUNĂ, cum a cerut Vali — sunt același fel
// de client, iar separat nu spun nimic. Se pot vedea și separat, cu
// ?separat=1 sau din linkul de sub tabel; nu se pierde nimic prin însumare.
const GRUPURI_BAZA = [
  { cheie: "delivery", nume: "Delivery Solutions", bucati: ["deliverysolution"], impreuna: "curieri" },
  { cheie: "cargus", nume: "Cargus", bucati: ["cargus"], impreuna: "curieri" },
  { cheie: "emag", nume: "eMAG Retail", bucati: ["emagretail", "danteinternational"] },
  { cheie: "posta", nume: "Poșta Română", bucati: ["postaromana"] },
];
const NUME_IMPREUNA = { curieri: "Delivery + Cargus" };

function grupuri(separat) {
  if (separat) return GRUPURI_BAZA.map((g) => ({ cheie: g.cheie, nume: g.nume, bucati: g.bucati.slice() }));
  const out = [];
  const vazut = new Map();
  for (const g of GRUPURI_BAZA) {
    if (!g.impreuna) {
      out.push({ cheie: g.cheie, nume: g.nume, bucati: g.bucati.slice() });
      continue;
    }
    if (!vazut.has(g.impreuna)) {
      const nou = { cheie: g.impreuna, nume: NUME_IMPREUNA[g.impreuna] || g.nume, bucati: g.bucati.slice() };
      vazut.set(g.impreuna, nou);
      out.push(nou);
    } else {
      vazut.get(g.impreuna).bucati.push(...g.bucati);
    }
  }
  return out;
}

// Scoase din calcul cu totul, la cererea lui.
const EXCLUSE = [
  { nume: "Negru and Negru", bucati: ["negruandnegru", "negrusinegru"] },
  { nume: "BCR Leasing", bucati: ["bcrleasing"] },
];

const WAREHOUSE = "warehouseall";
// Pragul de la care o factură Warehouse All iese din calcul. Era 200.000;
// Vali l-a coborât la 100.000 — o factură de peste atât mută procentele unei
// luni întregi și ascunde ce s-a întâmplat de fapt cu clienții obișnuiți.
const PRAG_IMPLICIT = 100000;

function potrivit(lista, numeStrans) {
  for (const g of lista) for (const b of g.bucati) if (numeStrans.includes(b)) return g;
  return null;
}

// Interval: de la 1 ianuarie al anului curent până azi, dacă nu se cere altfel.
function interval(query) {
  const azi = new Date().toISOString().slice(0, 10);
  const data = (v, implicit) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : implicit);
  const deLa = data(query && query.de_la, azi.slice(0, 4) + "-01-01");
  const panaLa = data(query && query.pana_la, azi);
  return { deLa, panaLa };
}

async function culege({ deLa, panaLa, prag, separat }) {
  const GRUPURI = grupuri(separat);
  const randuri = await db
    .prepare(
      `SELECT SUBSTR(f.data_emiterii, 1, 7) AS luna,
              p.nume AS partener,
              COALESCE(fi.nume, '') AS firma,
              COALESCE(l.net, 0) AS net,
              CASE WHEN l.net IS NULL THEN 1 ELSE 0 END AS fara_linii
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN firme fi ON fi.id = f.firma_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar) AS net
                      FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
        WHERE f.directie = 'vanzare'
          AND f.status NOT IN ('anulata','ciorna')
          AND COALESCE(f.intercompany, 0) = 0
          AND SUBSTR(f.data_emiterii, 1, 10) >= ?
          AND SUBSTR(f.data_emiterii, 1, 10) <= ?`
    )
    .all(deLa, panaLa);

  const luni = new Map();
  const cheile = GRUPURI.map((g) => g.cheie);
  const lunaGoala = () => {
    const o = { total: 0, altii: 0, nr: 0, faraLinii: 0 };
    for (const c of cheile) o[c] = 0;
    return o;
  };

  const scoase = { excluse: 0, sumaExcluse: 0, warehouse: 0, sumaWarehouse: 0 };
  const numeGasite = new Map(); // ce firme au intrat în fiecare grup
  let faraLinii = 0;

  for (const r of randuri) {
    const luna = String(r.luna || "").slice(0, 7);
    if (!luna) continue;
    const nume = strans(r.partener);
    const net = Number(r.net || 0);

    const exclus = potrivit(EXCLUSE, nume);
    if (exclus) {
      scoase.excluse++;
      scoase.sumaExcluse += net;
      continue;
    }
    // Facturile mari de la Warehouse All ies. Pragul se aplică pe suma fără
    // TVA, fiindcă tot fără TVA e și raportul.
    if (strans(r.firma).includes(WAREHOUSE) && net > prag) {
      scoase.warehouse++;
      scoase.sumaWarehouse += net;
      continue;
    }

    if (!luni.has(luna)) luni.set(luna, lunaGoala());
    const L = luni.get(luna);
    L.total += net;
    L.nr++;
    if (Number(r.fara_linii)) {
      L.faraLinii++;
      faraLinii++;
    }
    const grup = potrivit(GRUPURI, nume);
    if (grup) {
      L[grup.cheie] += net;
      if (!numeGasite.has(grup.cheie)) numeGasite.set(grup.cheie, new Set());
      numeGasite.get(grup.cheie).add(r.partener);
    } else {
      L.altii += net;
    }
  }

  const ordonate = [...luni.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = lunaGoala();
  for (const [, L] of ordonate) {
    total.total += L.total;
    total.altii += L.altii;
    total.nr += L.nr;
    total.faraLinii += L.faraLinii;
    for (const c of cheile) total[c] += L[c];
  }
  return { luni: ordonate, total, scoase, numeGasite, faraLinii, grupuri: GRUPURI };
}

const LUNI_RO = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "nov", "dec"];
const numeLuna = (l) => {
  const [a, m] = String(l).split("-");
  return `${LUNI_RO[Number(m) - 1] || m} ${a}`;
};
const proc = (parte, tot) => (Number(tot) ? (Number(parte) / Number(tot)) * 100 : 0);
const pct = (parte, tot) =>
  `<span style="color:var(--text-muted);font-size:12px">${proc(parte, tot).toFixed(1).replace(".", ",")}%</span>`;

function register(router) {
  router.get("/rapoarte/clienti-cheie", async (ctx) => {
    const { deLa, panaLa } = interval(ctx.query);
    const prag = Math.max(0, Number(String((ctx.query && ctx.query.prag) || "").replace(/[^\d]/g, "")) || PRAG_IMPLICIT);
    const separat = String((ctx.query && ctx.query.separat) || "") === "1";
    const d = await culege({ deLa, panaLa, prag, separat });
    const GRUPURI = d.grupuri;
    const adresa = (extra) =>
      "/rapoarte/clienti-cheie?de_la=" + encodeURIComponent(deLa) + "&pana_la=" + encodeURIComponent(panaLa) +
      "&prag=" + prag + (extra || "");

    const capete = ["Luna", ...GRUPURI.map((g) => g.nume), "Ceilalți", "Total lună", "Facturi"];
    const randuri = d.luni.map(([luna, L]) => [
      `<strong>${esc(numeLuna(luna))}</strong>`,
      ...GRUPURI.map((g) => `${money(L[g.cheie])}<br>${pct(L[g.cheie], L.total)}`),
      `${money(L.altii)}<br>${pct(L.altii, L.total)}`,
      `<strong>${money(L.total)}</strong>`,
      String(L.nr) + (L.faraLinii ? ` <span style="color:var(--danger)" title="fără linii, valorează 0">(${L.faraLinii})</span>` : ""),
    ]);
    randuri.push([
      "<strong>TOTAL</strong>",
      ...GRUPURI.map((g) => `<strong>${money(d.total[g.cheie])}</strong><br>${pct(d.total[g.cheie], d.total.total)}`),
      `<strong>${money(d.total.altii)}</strong><br>${pct(d.total.altii, d.total.total)}`,
      `<strong>${money(d.total.total)}</strong>`,
      `<strong>${d.total.nr}</strong>`,
    ]);

    const ceAIntrat = GRUPURI.map((g) => {
      const s = d.numeGasite.get(g.cheie);
      return `<li><strong>${esc(g.nume)}</strong>: ${s && s.size ? esc([...s].join(", ")) : '<span style="color:var(--danger)">nicio firmă potrivită</span>'}</li>`;
    }).join("");

    const body = `
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        Facturat <strong>fără TVA</strong> (cantitate × preț unitar), doar vânzări, fără facturile
        între firmele grupului. Procentele se calculează <em>după</em> excluderi — altfel n-ar însemna nimic.
      </p>

      <form class="filtre" method="get" action="/rapoarte/clienti-cheie" style="margin-bottom:6px">
        <label>De la <input type="date" name="de_la" value="${esc(deLa)}"></label>
        <label>Până la <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
        <label>Prag Warehouse All <input type="number" name="prag" step="1000" value="${prag}" style="width:130px"></label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" name="separat" value="1"${separat ? " checked" : ""}>
          Delivery și Cargus separat
        </label>
        <button class="btn secondary small" type="submit">Arată</button>
      </form>
      <p style="margin:0 0 14px;font-size:12px;color:var(--text-muted)">
        ${
          separat
            ? `Delivery și Cargus sunt pe coloane separate. <a href="${esc(adresa())}">Numără-i împreună →</a>`
            : `Delivery și Cargus sunt numărați împreună. <a href="${esc(adresa("&separat=1"))}">Vezi-i separat →</a>`
        }
      </p>

      <div class="cards">
        <div class="card"><div class="label">Total fără TVA</div><div class="value">${money(d.total.total)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${d.total.nr} facturi</div></div>
        ${GRUPURI.map(
          (g) => `<div class="card"><div class="label">${esc(g.nume)}</div>
            <div class="value">${proc(d.total[g.cheie], d.total.total).toFixed(1).replace(".", ",")}%</div>
            <div style="font-size:12px;color:var(--text-muted)">${money(d.total[g.cheie])}</div></div>`
        ).join("")}
        <div class="card"><div class="label">Ceilalți</div>
          <div class="value">${proc(d.total.altii, d.total.total).toFixed(1).replace(".", ",")}%</div>
          <div style="font-size:12px;color:var(--text-muted)">${money(d.total.altii)}</div></div>
      </div>

      ${
        d.faraLinii
          ? `<p style="margin:14px 0 0;color:var(--danger);font-size:13px;max-width:900px">
               <strong>${d.faraLinii} facturi din interval n-au nicio linie</strong>, deci valorează zero aici —
               cifrele de mai jos sunt mai mici decât realitatea.
               <a href="/admin/date">Vezi verificarea</a> și completează-le din SmartBill.
             </p>`
          : ""
      }

      <h2>Lună cu lună</h2>
      ${d.luni.length ? table(capete, randuri) : "<p>Nicio factură în intervalul ales.</p>"}

      <h2>Ce s-a scos din calcul</h2>
      <ul style="font-size:13px;line-height:1.7">
        <li>${EXCLUSE.map((e) => esc(e.nume)).join(" și ")}: <strong>${d.scoase.excluse}</strong> facturi, ${money(d.scoase.sumaExcluse)}</li>
        <li>Facturi Warehouse All peste ${money(prag)} fără TVA: <strong>${d.scoase.warehouse}</strong> facturi, ${money(d.scoase.sumaWarehouse)}</li>
        <li style="color:var(--text-muted)">Facturile între firmele grupului nu intră niciodată în raport.</li>
      </ul>

      <h2>Ce firme au intrat în fiecare grup</h2>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 6px">
        Potrivirea se face pe nume, fără diacritice și fără punctuație. Dacă vezi aici o firmă care n-ar trebui,
        sau lipsește una, spune-mi și schimb bucata de nume.
      </p>
      <ul style="font-size:13px;line-height:1.7">${ceAIntrat}</ul>`;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Clienți cheie vs. restul", active: "/rapoarte", body }));
  });
}

module.exports = { register, culege, strans, potrivit, grupuri, GRUPURI_BAZA, EXCLUSE, PRAG_IMPLICIT, interval };
