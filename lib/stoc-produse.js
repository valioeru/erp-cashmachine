"use strict";
// Stocul la zi pe PRODUSE: ce e în CT-Park, cât e promis, cât e rezervat de
// agenți, cât e liber și ce urmează să intre.
//
// CE A CERUT VALI, 09.11.2026:
//   „O pagină la agenții de vânzări și nu numai, cu stoc la zi. În ea să fie
//    vizibil stocul de produse finite, materii prime etc. din depozit, cu
//    filtre pe categorii, pe orice se poate, inclusiv marcate produsele ce sunt
//    comandate și urmează să ajungă în stoc, inclusiv data, sau cele care sunt
//    în producție și urmează să intre în stoc. La fiecare produs agenții să
//    poată rezerva pentru 3 zile…" (rezervările: lib/rezervari-agenti.js)
//   „Asta cu stocul să fie în Depozit, în principal, și userii să aibă acces la
//    această pagină, nu la tot depozitul."
//
// Pagina veche „Stoc la zi" arăta paleții, unul sub altul. Un agent nu întreabă
// „ce paleți avem", întreabă „cât am liber din produsul ăsta". De-aia aici
// paleții se adună pe produs, iar lângă stoc stă tot ce îl mușcă:
//
//   ÎN STOC      — liniile paleților încă în CT-Park (ct_palet_linii), singurul
//                  depozit. Fulfillment e altă gestiune și nu intră.
//   PROMIS       — marfă care e a cuiva, deși stă pe raft:
//                  • comenzile deschise ale clienților (nici anulate, nici
//                    livrate, nici ciorne), minus ce a ieșit deja din CT-Park
//                    pe ele și minus ce se produce încă pentru clientul ăla —
//                    aia vine separat, nu din raft;
//                  • paleții veniți din producția făcută pentru un client, când
//                    producția n-are comandă în ERP (registrul de producție e
//                    plin de comenzi Sameday, DELIVERY SOLUTIONS etc. scrise
//                    direct acolo). Marfa făcută pentru Sameday nu e liberă.
//                  Pe același client cele două nu se adună: paleții făcuți
//                  pentru el și comanda lui sunt, de cele mai multe ori, aceeași
//                  marfă. Se ia cea mai mare dintre ele.
//   REZERVAT     — rezervările active ale agenților (3 zile).
//   DISPONIBIL   — stoc − promis − rezervat, niciodată sub zero.
//   URMEAZĂ      — comenzile către furnizori trimise și neprimite (cât mai e de
//                  primit, cu data cerută) și producția: în lucru, sau gata și
//                  încă nepreluată de depozit. Producția făcută pentru un client
//                  se arată cu numele lui și NU intră la „liber în drum".
//
// Unitățile: „buc" și „bucata" sunt același lucru (au apărut amândouă pe
// paleți). Socoteala se face în unitatea în care stă cel mai mult din produs;
// ce e scris în altă unitate se arată separat și nu se amestecă în cifre.
//
// Socoteala e într-o funcție fără bază de date (`construieste`), ca s-o poată
// verifica un test cu numere știute. `citeste` doar aduce rândurile.

const db = require("./db");

const EPS = 0.0005;

// „buc", „Buc.", „bucată", „bucăți", „pcs" → „buc". Restul rămâne cum e scris,
// cu litere mici și fără diacritice.
function normUm(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.+$/, "");
  if (!s) return "";
  if (/^(buc|bucata|bucati|pcs|pc|bc)$/.test(s)) return "buc";
  if (/^(rola|role|roll|rolls)$/.test(s)) return "rola";
  if (/^(kg|kgs|kilogram|kilograme)$/.test(s)) return "kg";
  return s;
}

// Cantitatea din comenzile de producție e text („240", „2,5", „1.250,5").
// Un singur separator se citește ca la recepția din producție
// (lib/stadiu-comanda.js, Number): „26.148" = 26,148, „2,5" = 2,5. Punct ȘI
// virgulă înseamnă limpede punct la mii: „1.250,5" = 1250,5. Ce nu începe cu
// un număr e zero — nu se ghicește.
function numarText(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v == null ? "" : v).replace(/\s+/g, "");
  if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  const m = s.match(/^\d+([.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : 0;
}

const zi = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ""));
  if (m) return m[1];
  const r = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(v || ""));
  return r ? `${r[3]}-${r[2]}-${r[1]}` : "";
};
const rotunjit = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

// Starea producției: în lucru, sau gata și nepreluată de depozit (aceeași
// regulă ca lib/stadiu-comanda.js). Producția gata care n-a fost trimisă
// niciodată în depozit e din registrul vechi, de dinainte de 05.11.2026 —
// marfa aia a plecat demult și n-are ce căuta la „urmează să intre".
function productiaInDrum(cp) {
  const s = String(cp.status || "");
  if (s === "noua" || s === "in_productie") return true;
  if (s !== "finalizata" && s !== "facturata") return false;
  if (!cp.trimisa_depozit_la) return false;
  if (cp.receptie_id) return ["asteptata", "in_lucru"].includes(String(cp.receptie_stare || ""));
  return String(cp.cerere_stare || "") !== "primita";
}

const cheieProdus = (id, text) => (Number(id) ? "p:" + Number(id) : "t:" + String(text || "").trim().toLowerCase());
const cheieClient = (id, text) => (Number(id) ? "p:" + Number(id) : String(text || "").trim() ? "t:" + String(text).trim().toLowerCase() : "");

// d = {
//   linii     — liniile paleților din CT-Park: { produs_id, produs_text, um, lot,
//               cantitate, palet_id, categorie, data_intrare, furnizor,
//               cp_id, cp_numar, cp_comanda_id, cp_client_id, cp_client }
//   produse   — Map id → { denumire, cod, categorie, familie, unitate_masura }
//   furnizor  — liniile comenzilor către furnizori încă de primit:
//               { cf_id, numar, data_solicitata, furnizor, produs_id, denumire,
//                 cantitate, cantitate_primita, um }
//   productie — producția în drum, pe produs: { cp_id, numar, status, produs_id,
//               denumire, cantitate, um, data, comanda_id, comanda_numar,
//               client_id, client }
//   comenzi   — liniile comenzilor deschise: { comanda_id, numar, status,
//               partener_id, client, produs_id, cantitate, um }
//   iesite    — ce a ieșit din CT-Park pe comenzi: { comanda_id, produs_id, cantitate }
//   rezervari — rezervările active: { id, produs_id, partener_id, client,
//               utilizator_id, agent, cantitate, um, creata_la, expira_la, observatii }
//   vedeTot   — cine are tot Depozitul vede și furnizorii
// }
function construieste(d) {
  const o = d || {};
  const produse = o.produse instanceof Map ? o.produse : new Map();
  const vedeTot = Boolean(o.vedeTot);
  const randuri = new Map();

  function rand(produsId, text) {
    const cheie = cheieProdus(produsId, text);
    let r = randuri.get(cheie);
    if (!r) {
      const p = Number(produsId) ? produse.get(Number(produsId)) : null;
      r = {
        cheie,
        produs_id: Number(produsId) || null,
        denumire: (p && p.denumire) || String(text || "").trim() || "(fără denumire)",
        cod: (p && p.cod) || "",
        categorie: (p && p.categorie) || "",
        familie: (p && p.familie) || "",
        umProdus: normUm(p && p.unitate_masura),
        _stocPeUm: new Map(),
        _paleti: new Set(),
        _loturi: new Set(),
        _tipuri: new Map(),
        _furnizori: new Set(),
        _dedicat: [],
        _comenzi: [],
        intrari: [],
        rezervari: [],
        prima_intrare: "",
        ultima_intrare: "",
      };
      randuri.set(cheie, r);
    }
    return r;
  }

  // 1. Stocul fizic.
  for (const l of o.linii || []) {
    const q = Number(l.cantitate) || 0;
    if (q <= EPS) continue;
    const r = rand(l.produs_id, l.produs_text);
    const u = normUm(l.um) || r.umProdus;
    r._stocPeUm.set(u, (r._stocPeUm.get(u) || 0) + q);
    if (l.palet_id) r._paleti.add(Number(l.palet_id));
    if (l.lot && String(l.lot).trim()) r._loturi.add(String(l.lot).trim());
    const tip = String(l.categorie || "").trim();
    if (tip) r._tipuri.set(tip, (r._tipuri.get(tip) || 0) + q);
    if (vedeTot && l.furnizor && String(l.furnizor).trim()) r._furnizori.add(String(l.furnizor).trim());
    const z = zi(l.data_intrare);
    if (z && (!r.prima_intrare || z < r.prima_intrare)) r.prima_intrare = z;
    if (z && z > r.ultima_intrare) r.ultima_intrare = z;
    // Paletul a venit din producția făcută pentru un client, iar producția
    // n-are comandă în ERP: marfa e a clientului ăluia.
    const client = cheieClient(l.cp_client_id, l.cp_client);
    if (l.cp_id && !Number(l.cp_comanda_id) && client) {
      r._dedicat.push({ client, nume: l.cp_client || "", cantitate: q, um: u, document: l.cp_numar || "#" + l.cp_id });
    }
  }

  // 2. Ce urmează să intre: comenzile către furnizori.
  for (const f of o.furnizor || []) {
    const rest = (Number(f.cantitate) || 0) - (Number(f.cantitate_primita) || 0);
    if (rest <= EPS || !Number(f.produs_id)) continue;
    const r = rand(f.produs_id, f.denumire);
    r.intrari.push({
      fel: "furnizor",
      cantitate: rotunjit(rest),
      um: normUm(f.um) || r.umProdus,
      data: zi(f.data_solicitata),
      document: f.numar || "#" + f.cf_id,
      document_id: Number(f.cf_id) || null,
      furnizor: vedeTot ? f.furnizor || "" : "",
      client: "",
      liber: true,
    });
  }

  // 3. … și producția.
  for (const p of o.productie || []) {
    const q = Number(p.cantitate) || 0;
    if (q <= EPS || !Number(p.produs_id)) continue;
    const r = rand(p.produs_id, p.denumire);
    const client = cheieClient(p.client_id, p.client);
    r.intrari.push({
      fel: "productie",
      cantitate: rotunjit(q),
      um: normUm(p.um) || r.umProdus,
      data: zi(p.data),
      document: p.numar || "#" + p.cp_id,
      document_id: Number(p.cp_id) || null,
      stare: String(p.status || ""),
      furnizor: "",
      client: p.client || "",
      cheieClient: client,
      comanda_numar: p.comanda_numar || "",
      liber: !client,
    });
  }

  // 4. Rezervările active.
  for (const z of o.rezervari || []) {
    if (!Number(z.produs_id)) continue;
    const r = rand(z.produs_id, null);
    r.rezervari.push({
      id: Number(z.id),
      partener_id: Number(z.partener_id) || null,
      client: z.client || "",
      utilizator_id: Number(z.utilizator_id) || null,
      agent: z.agent || "",
      cantitate: rotunjit(z.cantitate),
      um: normUm(z.um) || r.umProdus,
      creata_la: String(z.creata_la || ""),
      expira_la: String(z.expira_la || ""),
      observatii: z.observatii || "",
    });
  }

  // 5. Comenzile deschise se lipesc doar de produsele care au deja rând: o
  // comandă pentru ceva ce nu e nici pe stoc, nici în drum, nici rezervat nu
  // e stoc, e cerere — o vede depozitul la el.
  const iesite = new Map();
  for (const x of o.iesite || []) {
    const k = Number(x.comanda_id) + ":" + Number(x.produs_id);
    iesite.set(k, (iesite.get(k) || 0) + (Number(x.cantitate) || 0));
  }
  const peComanda = new Map();
  for (const c of o.comenzi || []) {
    if (!Number(c.produs_id) || !Number(c.comanda_id)) continue;
    const r = randuri.get(cheieProdus(c.produs_id));
    if (!r) continue;
    const k = Number(c.comanda_id) + ":" + Number(c.produs_id);
    let x = peComanda.get(k);
    if (!x) {
      x = { r, comanda_id: Number(c.comanda_id), numar: c.numar || "#" + c.comanda_id, status: c.status || "", client: cheieClient(c.partener_id, c.client), nume: c.client || "", cantitate: 0, um: normUm(c.um) || r.umProdus };
      peComanda.set(k, x);
    }
    x.cantitate += Number(c.cantitate) || 0;
  }
  for (const [k, x] of peComanda) {
    const rest = x.cantitate - (iesite.get(k) || 0);
    if (rest > EPS) x.r._comenzi.push(Object.assign({}, x, { r: undefined, rest }));
  }

  // 6. Socoteala pe fiecare produs.
  const out = [];
  for (const r of randuri.values()) {
    let um = "";
    let max = -1;
    for (const [u, q] of r._stocPeUm) if (q > max) { max = q; um = u; }
    if (!um) {
      const prima = r.intrari.slice().sort((a, b) => b.cantitate - a.cantitate)[0];
      um = (prima && prima.um) || (r.rezervari[0] && r.rezervari[0].um) || r.umProdus || "";
    }
    const inUm = (x) => !x.um || x.um === um;
    const stoc = rotunjit(r._stocPeUm.get(um) || 0);
    const alteUm = [...r._stocPeUm].filter(([u, q]) => u !== um && q > EPS).map(([u, q]) => ({ um: u, cantitate: rotunjit(q) }));

    // Promisul, pe client.
    const clienti = new Map();
    const client = (cheie, nume) => {
      if (!clienti.has(cheie)) clienti.set(cheie, { cheie, nume: nume || "", comenzi: [], productii: [], dinComenzi: 0, inLucru: 0, dedicat: 0 });
      const c = clienti.get(cheie);
      if (!c.nume && nume) c.nume = nume;
      return c;
    };
    for (const c of r._comenzi) {
      if (!inUm(c)) continue;
      const x = client(c.client || "comanda:" + c.comanda_id, c.nume);
      x.dinComenzi += c.rest;
      x.comenzi.push({ comanda_id: c.comanda_id, numar: c.numar, status: c.status, cantitate: rotunjit(c.rest) });
    }
    for (const i of r.intrari) {
      if (i.fel !== "productie" || !i.cheieClient || !inUm(i)) continue;
      client(i.cheieClient, i.client).inLucru += i.cantitate;
    }
    for (const dd of r._dedicat) {
      if (!inUm(dd)) continue;
      const x = client(dd.client, dd.nume);
      x.dedicat += dd.cantitate;
      if (!x.productii.includes(dd.document)) x.productii.push(dd.document);
    }
    const promisPe = [];
    for (const c of clienti.values()) {
      const dinRaft = Math.max(0, c.dinComenzi - c.inLucru);
      const q = rotunjit(Math.max(dinRaft, c.dedicat));
      if (q <= EPS) continue;
      promisPe.push({ client: c.nume || "(client fără nume)", cantitate: q, comenzi: c.comenzi, productii: c.productii, facutPentru: c.dedicat >= dinRaft && c.dedicat > EPS });
    }
    promisPe.sort((a, b) => b.cantitate - a.cantitate || a.client.localeCompare(b.client, "ro"));
    const promis = rotunjit(promisPe.reduce((s, x) => s + x.cantitate, 0));

    r.rezervari.sort((a, b) => String(a.expira_la).localeCompare(String(b.expira_la)) || a.id - b.id);
    const rezervat = rotunjit(r.rezervari.filter(inUm).reduce((s, x) => s + x.cantitate, 0));
    const liberBrut = rotunjit(stoc - promis - rezervat);
    const disponibil = Math.max(0, liberBrut);

    r.intrari.sort((a, b) => (a.data || "9999").localeCompare(b.data || "9999") || b.cantitate - a.cantitate);
    const inDrum = rotunjit(r.intrari.filter((i) => i.liber && inUm(i)).reduce((s, i) => s + i.cantitate, 0));
    const inDrumClienti = rotunjit(r.intrari.filter((i) => !i.liber && inUm(i)).reduce((s, i) => s + i.cantitate, 0));
    const sosire = r.intrari.map((i) => i.data).filter(Boolean).sort()[0] || "";

    let stare;
    if (stoc <= EPS) stare = r.intrari.length ? "Urmează să intre" : "Fără stoc";
    else if (disponibil <= EPS) stare = rezervat > EPS ? "Rezervat integral" : "Promis integral";
    else if (rezervat > EPS) stare = "Rezervat parțial";
    else stare = "Disponibil";

    let tip = "";
    let maxTip = -1;
    for (const [t, q] of r._tipuri) if (q > maxTip) { maxTip = q; tip = t; }

    out.push({
      cheie: r.cheie,
      produs_id: r.produs_id,
      denumire: r.denumire,
      cod: r.cod,
      categorie: r.categorie,
      familie: r.familie,
      tip,
      um,
      stoc,
      alteUm,
      paleti: r._paleti.size,
      loturi: [...r._loturi].sort((a, b) => a.localeCompare(b, "ro")),
      furnizori: [...r._furnizori].sort((a, b) => a.localeCompare(b, "ro")),
      prima_intrare: r.prima_intrare,
      ultima_intrare: r.ultima_intrare,
      promis,
      promisPe,
      rezervat,
      rezervari: r.rezervari,
      disponibil: rotunjit(disponibil),
      depasit: liberBrut < -EPS ? rotunjit(-liberBrut) : 0,
      intrari: r.intrari,
      inDrum,
      inDrumClienti,
      sosire,
      stare,
    });
  }
  return out.sort((a, b) => a.denumire.localeCompare(b.denumire, "ro") || String(a.cod).localeCompare(String(b.cod)));
}

// Textul în care caută căsuța de căutare. Furnizorii intră doar pentru cine îi
// vede (rândul îi are doar atunci) — altfel agentul i-ar afla căutând.
function textCautare(r) {
  return [
    r.denumire,
    r.cod,
    r.familie,
    r.categorie,
    r.tip,
    r.loturi.join(" "),
    r.furnizori.join(" "),
    r.rezervari.map((x) => x.client + " " + x.agent).join(" "),
    r.promisPe.map((x) => x.client + " " + x.comenzi.map((c) => c.numar).join(" ")).join(" "),
    r.intrari.map((i) => i.document + " " + i.client + " " + i.furnizor).join(" "),
  ]
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const STARI_COMANDA_INCHISE = ["anulata", "livrata", "ciorna"];

async function citeste(opt) {
  const vedeTot = Boolean(opt && opt.vedeTot);
  // Liniile paleților. Un palet fără nicio linie (scris înainte de liniile pe
  // palet și neatins de migrare până la următoarea pornire) intră cu
  // coloanele lui vechi — exact cum îl arată vederea pe paleți, ca cele două
  // vederi să spună același stoc.
  const coloane = `p.id AS palet_id, p.categorie, p.data_intrare,
              COALESCE(f.nume, NULLIF(TRIM(p.furnizor_text), '')) AS furnizor,
              cp.id AS cp_id, cp.numar AS cp_numar, cp.comanda_id AS cp_comanda_id,
              cp.partener_id AS cp_client_id, COALESCE(pp.nume, NULLIF(TRIM(cp.client_text), '')) AS cp_client`;
  const legaturi = `LEFT JOIN parteneri f ON f.id = p.furnizor_id
         LEFT JOIN receptii r ON r.id = p.receptie_id
         LEFT JOIN comenzi_productie cp ON cp.id = r.comanda_productie_id AND cp.status <> 'anulata'
         LEFT JOIN parteneri pp ON pp.id = cp.partener_id`;
  const linii = await db
    .prepare(
      `SELECT * FROM (
         SELECT pl.produs_id, pl.produs_text, pl.um, pl.lot, pl.cantitate, pl.id AS linie_id, ${coloane}
           FROM ct_palet_linii pl
           JOIN ct_paleti p ON p.id = pl.palet_id
           ${legaturi}
          WHERE p.data_iesire IS NULL AND pl.cantitate > 0
         UNION ALL
         SELECT p.produs_id, p.produs_text, p.um, p.lot, p.cantitate, 0 AS linie_id, ${coloane}
           FROM ct_paleti p
           ${legaturi}
          WHERE p.data_iesire IS NULL AND p.cantitate > 0
            AND NOT EXISTS (SELECT 1 FROM ct_palet_linii x WHERE x.palet_id = p.id)
       ) t
       ORDER BY data_intrare, palet_id, linie_id`
    )
    .all();

  const furnizor = await db
    .prepare(
      `SELECT cf.id AS cf_id, cf.numar, cf.data_solicitata, pa.nume AS furnizor,
              l.produs_id, l.denumire, l.cantitate, l.cantitate_primita, l.um
         FROM comenzi_furnizor cf
         JOIN comenzi_furnizor_linii l ON l.comanda_id = cf.id
         LEFT JOIN parteneri pa ON pa.id = cf.furnizor_id
        WHERE cf.status IN ('trimisa', 'confirmata', 'partial')
          AND l.produs_id IS NOT NULL
          AND l.cantitate - COALESCE(l.cantitate_primita, 0) > 0`
    )
    .all()
    .catch(() => []);

  const cps = (
    await db
      .prepare(
        `SELECT cp.id, cp.numar, cp.status, cp.produs_id, cp.cantitate, cp.um, cp.tip_produs,
                cp.data_livrare, cp.data_propusa, cp.data_solicitata, cp.comanda_id, cp.trimisa_depozit_la,
                cp.receptie_id, r.stare AS receptie_stare, a.status AS cerere_stare,
                c.numar AS comanda_numar,
                COALESCE(c.partener_id, cp.partener_id) AS client_id,
                COALESCE(pc.nume, pp.nume, NULLIF(TRIM(cp.client_text), '')) AS client
           FROM comenzi_productie cp
           LEFT JOIN receptii r ON r.id = cp.receptie_id
           LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
           LEFT JOIN comenzi c ON c.id = cp.comanda_id
           LEFT JOIN parteneri pc ON pc.id = c.partener_id
           LEFT JOIN parteneri pp ON pp.id = cp.partener_id
          WHERE cp.status IN ('noua', 'in_productie', 'finalizata', 'facturata')`
      )
      .all()
      .catch(() => [])
  ).filter(productiaInDrum);
  const idCp = cps.map((c) => Number(c.id));
  const liniiCp = idCp.length
    ? await db
        .prepare(
          `SELECT comanda_id, produs_id, denumire, cantitate, um FROM comenzi_productie_linii
            WHERE comanda_id IN (${idCp.map(() => "?").join(",")}) ORDER BY comanda_id, ordine, id`
        )
        .all(...idCp)
        .catch(() => [])
    : [];
  const pePeCp = new Map();
  for (const l of liniiCp) {
    const k = Number(l.comanda_id);
    if (!pePeCp.has(k)) pePeCp.set(k, []);
    pePeCp.get(k).push(l);
  }
  const productie = [];
  for (const cp of cps) {
    const baza = {
      cp_id: Number(cp.id),
      numar: cp.numar,
      status: cp.status,
      data: cp.data_livrare || cp.data_propusa || cp.data_solicitata || "",
      comanda_id: Number(cp.comanda_id) || null,
      comanda_numar: cp.comanda_numar || "",
      client_id: Number(cp.client_id) || null,
      client: cp.client || "",
    };
    const ls = pePeCp.get(Number(cp.id)) || [];
    if (ls.length) {
      for (const l of ls) productie.push(Object.assign({}, baza, { produs_id: l.produs_id, denumire: l.denumire, cantitate: numarText(l.cantitate), um: l.um }));
    } else if (Number(cp.produs_id)) {
      productie.push(Object.assign({}, baza, { produs_id: cp.produs_id, denumire: cp.tip_produs, cantitate: numarText(cp.cantitate), um: cp.um }));
    }
  }

  const comenzi = await db
    .prepare(
      `SELECT c.id AS comanda_id, c.numar, c.status, c.partener_id, pa.nume AS client,
              l.produs_id, l.cantitate, l.um
         FROM comenzi c
         JOIN comenzi_linii l ON l.comanda_id = c.id
         LEFT JOIN parteneri pa ON pa.id = c.partener_id
        WHERE c.status NOT IN (${STARI_COMANDA_INCHISE.map(() => "?").join(",")})`
    )
    .all(...STARI_COMANDA_INCHISE)
    .catch(() => []);
  const idComenzi = [...new Set(comenzi.map((c) => Number(c.comanda_id)))];
  // Ce a ieșit deja din CT-Park pe comenzile astea. Ieșirea parțială își scrie
  // liniile; ieșirea întreagă scoate paletul cu ce avea pe el.
  const semne = idComenzi.map(() => "?").join(",");
  const iesite = idComenzi.length
    ? await db
        .prepare(
          `SELECT i.comanda_id, il.produs_id, SUM(il.cantitate) AS cantitate
             FROM ct_iesiri i JOIN ct_iesiri_linii il ON il.iesire_id = i.id
            WHERE i.comanda_id IN (${semne})
            GROUP BY i.comanda_id, il.produs_id
           UNION ALL
           SELECT i.comanda_id, pl.produs_id, SUM(pl.cantitate) AS cantitate
             FROM ct_iesiri i JOIN ct_palet_linii pl ON pl.palet_id = i.palet_id
            WHERE i.comanda_id IN (${semne})
              AND NOT EXISTS (SELECT 1 FROM ct_iesiri_linii x WHERE x.iesire_id = i.id)
            GROUP BY i.comanda_id, pl.produs_id`
        )
        .all(...idComenzi, ...idComenzi)
        .catch(() => [])
    : [];

  const rezervari = await db
    .prepare(
      `SELECT r.id, r.produs_id, r.partener_id, pa.nume AS client, r.utilizator_id,
              COALESCE(u.nume, r.utilizator_nume) AS agent, r.cantitate, r.um,
              r.creata_la, r.expira_la, r.observatii
         FROM rezervari_agenti r
         LEFT JOIN parteneri pa ON pa.id = r.partener_id
         LEFT JOIN utilizatori u ON u.id = r.utilizator_id
        WHERE r.stare = 'activa'`
    )
    .all()
    .catch(() => []);

  const idProduse = [
    ...new Set(
      []
        .concat(linii, furnizor, productie, rezervari)
        .map((x) => Number(x.produs_id))
        .filter(Boolean)
    ),
  ];
  const produse = new Map();
  if (idProduse.length) {
    const ps = await db
      .prepare(
        `SELECT p.id, p.denumire, COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod, p.categorie,
                p.unitate_masura, cf.nume AS familie
           FROM produse p LEFT JOIN cod_familii cf ON cf.id = p.cod_familie_id
          WHERE p.id IN (${idProduse.map(() => "?").join(",")})`
      )
      .all(...idProduse);
    for (const p of ps) produse.set(Number(p.id), p);
  }

  return construieste({ linii, produse, furnizor, productie, comenzi, iesite, rezervari, vedeTot });
}

module.exports = { EPS, normUm, numarText, productiaInDrum, construieste, textCautare, citeste, STARI_COMANDA_INCHISE };
