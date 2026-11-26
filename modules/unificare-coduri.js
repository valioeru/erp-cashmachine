"use strict";
// Configurări · Unificare coduri.
//
// CEREREA LUI VALI, 17.11.2026: „Vreau să găsim o soluție să folosim aceleași
// coduri pentru produse; acum sunt aceleași produse cu diverse coduri. Propun
// o pagină de configurare unde să asociezi tu, la produsele cu coduri noi,
// toate produsele cu stoc care ți se par similare, iar odată ce noi validăm să
// ștergi produsul vechi și să muți stocul pe noul produs, cu modificare peste
// tot în depozit etc. […] Pune pagina asta de configurări produse temporar în
// Configurări, Management, undeva, dar distinctă de alte pagini."
//
// CE FACE PAGINA:
//
//   1. „Produse vechi cu stoc": fiecare produs cu cod vechi care are marfă în
//      CT-Park, cu propunerile lui — fratele „scris de două ori", ce a asociat
//      un om de mână și produsele cu cod nou care seamănă. La fiecare
//      propunere: „Unifică" (întâi se vede ce se mută) sau „Nu e același
//      produs" (nu se mai propune). Produsul care n-are ce căuta aici
//      (transport, un serviciu) se scoate din listă cu „E bun așa"; cele
//      scoase stau într-o listă închisă, sub tabel, de unde se pot repune.
//   2. „Scrise de două ori, fără stoc": perechile „Denumire (COD)" ↔ „COD ·
//      Denumire" la care produsul fără cod n-are marfă. Se unifică în bloc, cu
//      bifă.
//
// PAGINA NU UNIFICĂ NIMIC SINGURĂ. Propune; validarea e a omului. Mutarea o
// face motorul vechi (lib/produse-fuziune.js): stocul, paleții, comenzile,
// facturile, rețetele trec pe produsul păstrat, iar cel vechi rămâne în bază,
// dezactivat și legat de el, ca istoricul să nu se rupă.
//
// Socoteala (cine cu cine seamănă) e în lib/unificare-coduri.js, fără bază.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const U = require("../lib/unificare-coduri");
const FZ = require("../lib/produse-fuziune");
const SP = require("../lib/stoc-produse");
const CV = require("../lib/cod-vechi");

const CALE = "/configurari/unificare-coduri";
// Câte perechi „scrise de două ori" încap pe pagină și cât durează, cel mult,
// o unificare în bloc: ce nu apucă rămâne bifabil pentru apăsarea următoare.
const PE_PAGINA = 200;
const BUGET_MS = 20000;

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const idDin = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const cant = (v) => nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const codulLui = (p) => String((p && (String(p.cod || "").trim() || String(p.cod_generat || "").trim())) || "");
const numeProdus = (p) =>
  p ? `${codulLui(p) ? `<code>${esc(codulLui(p))}</code> ` : ""}<a href="/produse/${p.id}">${esc(p.denumire || "#" + p.id)}</a>` : "—";
const lista = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

function subnav(activ) {
  // Aceleași legături ca în modules/configurari.js și modules/cod-produs.js.
  const linkuri = [
    ["/configurari/date", "Date importate"],
    ["/configurari/storno", "Facturi stornate"],
    ["/configurari/adrese", "Adrese de anunț"],
    ["/configurari/ignorati", "Parteneri ignorați"],
    ["/configurari/cod-produs", "Codul produsului"],
    [CALE, "Unificare coduri"],
    ["/configurari/unificare-clienti", "Unificare clienți"],
  ];
  return `<div class="subnav">${linkuri.map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`).join("")}</div>`;
}

// Produsele în joc (active, neunificate), stocul lor din CT-Park și ce a
// hotărât deja un om.
async function citeste() {
  const produse = await db
    .prepare(
      `SELECT id, cod, cod_generat, denumire, unitate_masura, cod_familie_id, categorie,
              COALESCE(pret_achizitie, 0) AS pret_achizitie, COALESCE(pret_vanzare, 0) AS pret_vanzare,
              COALESCE(cod_vechi_exceptat, 0) AS exceptat, parcat_la, parcat_fel, nascut_la
         FROM produse
        WHERE COALESCE(activ, 1) = 1 AND fuzionat_in IS NULL
        ORDER BY denumire, id`
    )
    .all();
  const dupaId = new Map(produse.map((p) => [Number(p.id), p]));
  // Stocul, cum îl arată „Stoc la zi": pe paleți și încă de pus pe raft.
  const stoc = new Map();
  for (const r of await SP.citeste({ vedeTot: true })) {
    if (r.produs_id && r.stoc > SP.EPS) stoc.set(Number(r.produs_id), { stoc: r.stoc, um: r.um || "", paleti: r.paleti, dePus: r.dePus });
  }
  const hotarari = await db
    .prepare(
      `SELECT a.vechi_id, a.nou_id, a.stare, a.fel, a.nota, a.facut_la, u.nume AS facut_de
         FROM produse_asocieri a LEFT JOIN utilizatori u ON u.id = a.facut_de`
    )
    .all()
    .catch(() => []);
  const respinse = new Set(hotarari.filter((h) => h.stare === "respinsa").map((h) => `${h.vechi_id}:${h.nou_id}`));
  const deMana = hotarari.filter((h) => h.stare === "propusa" && dupaId.has(Number(h.vechi_id)) && dupaId.has(Number(h.nou_id)));
  return { produse, dupaId, stoc, respinse, deMana };
}

// Ce are de arătat pagina: rândurile celor două părți.
// Produsul bun: făcut din configurator sau trecut de om ca „E bun așa". În el
// intră cele vechi; el nu intră în niciunul vechi.
const eBun = (p) => U.eNou(p) || Number(p && p.exceptat) === 1;

function socoteste(d) {
  const noi = d.produse.filter(eBun);
  const frati = U.perechi(d.produse).filter((x) => !d.respinse.has(`${x.vechi.id}:${x.nou.id}`));
  const frateLui = new Map(frati.map((x) => [Number(x.vechi.id), x]));
  // Perechile asociate de un om: doar ele se pot unifica una câte una.
  const asociate = new Map(d.deMana.map((h) => [`${h.vechi_id}:${h.nou_id}`, h]));

  // 1. Produsele vechi cu stoc, cu propunerile lor.
  const cuStoc = [];
  for (const p of d.produse) {
    if (U.eNou(p) || Number(p.exceptat) === 1 || !d.stoc.has(Number(p.id))) continue;
    const propuneri = [];
    const dejaPus = new Set();
    const pune = (x) => {
      if (dejaPus.has(Number(x.nou.id))) return;
      dejaPus.add(Number(x.nou.id));
      const h = asociate.get(`${p.id}:${x.nou.id}`);
      x.asociat = Boolean(h);
      if (h && !x.de) x.de = h.facut_de;
      propuneri.push(x);
    };
    const frate = frateLui.get(Number(p.id));
    if (frate) pune({ nou: frate.nou, fel: "pereche", sigura: frate.sigura, altele: frate.altele, scor: frate.sigura ? 1 : 0.9, motive: [] });
    for (const h of d.deMana) {
      if (Number(h.vechi_id) !== Number(p.id) || d.respinse.has(`${h.vechi_id}:${h.nou_id}`)) continue;
      pune({ nou: d.dupaId.get(Number(h.nou_id)), fel: "de_mana", scor: 0.95, motive: [], nota: h.nota, de: h.facut_de });
    }
    for (const x of U.propuneri(p, noi, d.respinse, 3)) pune(Object.assign({ fel: "asemanare" }, x));
    cuStoc.push({ p, stoc: d.stoc.get(Number(p.id)), propuneri });
  }
  cuStoc.sort(
    (a, b) =>
      (b.propuneri.length ? b.propuneri[0].scor : -1) - (a.propuneri.length ? a.propuneri[0].scor : -1) ||
      String(a.p.denumire).localeCompare(String(b.p.denumire), "ro") ||
      Number(a.p.id) - Number(b.p.id)
  );

  // 2. Scrise de două ori, cu produsul fără cod fără stoc.
  const faraStoc = frati
    .filter((x) => !d.stoc.has(Number(x.vechi.id)))
    .sort((a, b) => Number(b.sigura) - Number(a.sigura) || String(a.vechi.denumire).localeCompare(String(b.vechi.denumire), "ro") || Number(a.vechi.id) - Number(b.vechi.id));

  // 3. Cele scoase din listă cu „E bun așa", ca să poată fi repuse.
  const exceptate = d.produse.filter((p) => !U.eNou(p) && Number(p.exceptat) === 1);

  // 4. Cod vechi, fără stoc: la alegere apar cu „COD VECHI — nu selecta"
  //    (lib/cod-vechi.js). 5. Parcate: nu mai apar la alegere deloc.
  const azi = new Date().toISOString().slice(0, 10);
  const parcate = d.produse.filter((p) => CV.eParcat(p));
  const vechiFaraStoc = d.produse.filter((p) => !eBun(p) && !CV.eParcat(p) && !CV.eProaspat(p, azi) && !d.stoc.has(Number(p.id)));

  return { noi, cuStoc, faraStoc, exceptate, vechiFaraStoc, parcate };
}

const stocText = (s) =>
  s ? `${esc(cant(s.stoc))} ${esc(s.um)}${s.paleti ? ` · ${s.paleti} ${s.paleti === 1 ? "palet" : "paleți"}` : ""}${s.dePus > SP.EPS ? ` · ${esc(cant(s.dePus))} de pus pe raft` : ""}` : '<span style="color:var(--text-muted)">fără stoc</span>';

// Numele pe înțeles ale tabelelor din previzualizare; restul rămân cu numele lor.
const NUME_TABEL = {
  "ct_paleti.produs_id": "paleți",
  "ct_palet_linii.produs_id": "linii de marfă pe paleți",
  "receptii_linii.produs_id": "rânduri de recepție",
  "comenzi_linii.produs_id": "linii de comandă de client",
  "facturi_linii.produs_id": "linii de factură",
  "oferte_linii.produs_id": "linii de ofertă",
  "comenzi_furnizor_linii.produs_id": "linii de comandă la furnizor",
  "comenzi_productie.produs_id": "comenzi de producție",
  "comenzi_productie_linii.produs_id": "linii de comandă de producție",
  "comenzi_productie.materie_produs_id": "comenzi de producție (ca materie primă)",
  "retete_componente.produs_id": "rânduri de rețetă (ca produs)",
  "retete_componente.componenta_id": "rânduri de rețetă (ca materie primă)",
  "miscari_stoc.produs_id": "mișcări de stoc",
  "rezervari_agenti.produs_id": "rezervări ale agenților",
  "ct_iesiri_linii.produs_id": "linii de ieșire din depozit",
  "avize_linii.produs_id": "linii de aviz",
  "etichete_loturi.produs_id": "loturi de etichete",
};

// Locurile la care mutarea a căzut. Motorul le notează cu „ (eroare)" la coadă
// și merge mai departe: produsul vechi e dezactivat oricum, iar rândurile din
// locul acela rămân pe el. Pagina trebuie s-o spună, nu să raporteze reușită.
const COADA_EROARE = " (eroare)";
const locuriCazute = (mutari) =>
  Object.keys(mutari || {})
    .filter((k) => k.endsWith(COADA_EROARE))
    .map((k) => k.slice(0, -COADA_EROARE.length))
    .map((k) => NUME_TABEL[k] || k);

// Câte rânduri de rețetă are fiecare, ca produs fabricat. Dacă au amândouă,
// unificarea ar lipi cele două rețete una de alta (motorul mută rândurile, nu
// le alege): costul ar ieși din suma lor. Atunci nu se unifică până nu rămâne
// o singură rețetă.
async function reteteleLor(vechiId, nouId) {
  const cate = async (id) => {
    const r = await db.prepare("SELECT COUNT(*) AS n, 1 AS x FROM retete_componente WHERE produs_id = ?").get(id).catch(() => null);
    return Number(r && r.n) || 0;
  };
  return { vechi: await cate(vechiId), nou: await cate(nouId) };
}
const MESAJ_DOUA_RETETE =
  "Amândouă produsele au rețetă. Unificate, cel care rămâne ar avea rândurile amândurora și costul lor adunat. Șterge întâi rețeta care nu mai e bună (Producție → Rețete), apoi unifică.";

// Câmpurile goale ale produsului păstrat se completează din cel vechi. Ce are
// deja păstratul nu se atinge.
//
//   • Doar la aceeași unitate (un preț pe kg pus pe un produs numărat în role
//     ar fi o greșeală nouă): prețul de achiziție, costul de producție, prețul
//     de vânzare, prețul minim de vânzare și stocul minim.
//   • La orice unitate, fiindcă nu țin de ea: adaosul propriu (procent), costul
//     real din contabilitate (`cost_rata`, cost ÷ vânzări — din el iese marja
//     facturilor, care tocmai au trecut pe produsul păstrat), categoria,
//     gestiunea, categoria din depozit și furnizorul.
//   • Când rețeta a venit de la cel vechi (`cuReteta`): baza pe care e scrisă
//     (pe câte bucăți) și fluxul de producție. Fără bază, o rețetă scrisă la
//     mia de bucăți s-ar citi ca fiind pe bucată.
async function completeazaDinVechi(nouId, vechiId, opt) {
  const nou = await db.prepare("SELECT * FROM produse WHERE id = ?").get(nouId);
  const vechi = await db.prepare("SELECT * FROM produse WHERE id = ?").get(vechiId);
  if (!nou || !vechi) return [];
  const aceeasiUm = SP.normUm(nou.unitate_masura) === SP.normUm(vechi.unitate_masura);
  const puse = [];
  const pune = async (coloana, valoare, eticheta) => {
    await db.prepare(`UPDATE produse SET ${coloana} = ? WHERE id = ?`).run(valoare, nouId);
    puse.push(eticheta);
  };
  // Gol = nescris. Un zero scris de om (adaos 0%) e o valoare, nu un gol.
  const gol = (v) => v === null || v === undefined || String(v).trim() === "";
  if (aceeasiUm && !(nr(nou.pret_achizitie) > 0) && nr(vechi.pret_achizitie) > 0) await pune("pret_achizitie", nr(vechi.pret_achizitie), "prețul de achiziție");
  if (aceeasiUm && !(nr(nou.pret_productie) > 0) && nr(vechi.pret_productie) > 0) await pune("pret_productie", nr(vechi.pret_productie), "costul de producție");
  if (aceeasiUm && !(nr(nou.pret_vanzare) > 0) && nr(vechi.pret_vanzare) > 0) await pune("pret_vanzare", nr(vechi.pret_vanzare), "prețul de vânzare");
  if (aceeasiUm && !(nr(nou.pret_minim) > 0) && nr(vechi.pret_minim) > 0) await pune("pret_minim", nr(vechi.pret_minim), "prețul minim de vânzare");
  if (aceeasiUm && !(nr(nou.stoc_minim) > 0) && nr(vechi.stoc_minim) > 0) await pune("stoc_minim", nr(vechi.stoc_minim), "stocul minim");
  if (gol(nou.adaos_lista) && !gol(vechi.adaos_lista) && nr(vechi.adaos_lista) >= 0) await pune("adaos_lista", nr(vechi.adaos_lista), "adaosul propriu");
  if (!(nr(nou.cost_rata) > 0) && nr(vechi.cost_rata) > 0) {
    await pune("cost_rata", nr(vechi.cost_rata), "costul real din contabilitate");
    await db.prepare("UPDATE produse SET cost_rata_sursa = ? WHERE id = ?").run(gol(vechi.cost_rata_sursa) ? null : String(vechi.cost_rata_sursa), nouId);
  }
  if (!String(nou.categorie || "").trim() && String(vechi.categorie || "").trim()) await pune("categorie", String(vechi.categorie).trim(), "categoria");
  if (!String(nou.gestiune || "").trim() && String(vechi.gestiune || "").trim()) await pune("gestiune", String(vechi.gestiune).trim(), "gestiunea");
  if (!String(nou.categorie_depozit || "").trim() && String(vechi.categorie_depozit || "").trim()) await pune("categorie_depozit", String(vechi.categorie_depozit).trim(), "categoria din depozit");
  if (!nou.furnizor_id && vechi.furnizor_id) await pune("furnizor_id", Number(vechi.furnizor_id), "furnizorul");
  if (opt && opt.cuReteta) {
    if (!(nr(nou.reteta_baza) > 1) && nr(vechi.reteta_baza) > 1) await pune("reteta_baza", nr(vechi.reteta_baza), "baza rețetei");
    if (!nou.flux_id && vechi.flux_id) await pune("flux_id", Number(vechi.flux_id), "fluxul de producție");
  }
  return puse;
}

// Se poate unifica `vechi` în `nou`? Întoarce textul piedicii sau "".
// Pasul 2 înaintea pasului 3: perechea se unifică doar după ce un om a asociat-o
// (Vali, 18.11.2026: „activează butoanele abia după ce pasul anterior a fost făcut").
function neasociat(d, vechi, nou) {
  const e = d.deMana.some((h) => Number(h.vechi_id) === Number(vechi.id) && Number(h.nou_id) === Number(nou.id));
  return e ? "" : "Întâi pasul 2: asociază cele două produse (un om confirmă că e aceeași marfă). Abia apoi se pot unifica.";
}

// Marfa celor două produse, palet cu palet, cât e încă în depozit.
async function paletiiLor(vechiId, nouId) {
  return await db
    .prepare(
      `SELECT pl.id AS linie_id, pl.palet_id, p.cod AS palet, pl.produs_id, pl.cantitate, COALESCE(NULLIF(TRIM(pl.um), ''), pr.unitate_masura) AS um
         FROM ct_palet_linii pl JOIN ct_paleti p ON p.id = pl.palet_id LEFT JOIN produse pr ON pr.id = pl.produs_id
        WHERE pl.produs_id IN (?, ?) AND p.data_iesire IS NULL AND COALESCE(pl.cantitate, 0) > 0
        ORDER BY (pl.produs_id = ?) DESC, p.cod, pl.id`
    )
    .all(vechiId, nouId, vechiId)
    .catch(() => []);
}

// Cantitățile scrise la previzualizare (`cant_<linie>`), unde diferă de ce e
// în bază, se corectează pe palet, cu urmă în istoricul lui (aceeași corecție
// ca din fișa paletului). Se ating doar liniile celor două produse.
async function corecteazaPaletii(vechi, nou, corp, user) {
  const b = corp || {};
  const paleti = await paletiiLor(vechi.id, nou.id);
  const pePalet = new Map();
  for (const l of paleti) {
    const scris = String(b["cant_" + l.linie_id] == null ? "" : b["cant_" + l.linie_id]).trim();
    if (scris === "") continue;
    const n = Number(scris.replace(/ /g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return { eroare: `Paletul ${l.palet}: cantitatea „${scris}” nu e un număr. Scrie-o ca 1151 sau 12,5.`, corectate: [] };
    if (Math.abs(n - nr(l.cantitate)) < 0.0005) continue;
    if (!pePalet.has(l.palet_id)) pePalet.set(l.palet_id, { palet: l.palet, linii: {} });
    pePalet.get(l.palet_id).linii[l.linie_id] = { cantitate: String(n) };
  }
  const corectate = [];
  for (const [paletId, x] of pePalet) {
    const r = await require("./ct-park").corecteazaMarfa(user, paletId, { linii: x.linii, motiv: "numărat la unificarea codurilor" });
    if (r.eroare) return { eroare: `${r.eroare}${corectate.length ? ` (Corectate înainte de oprire: ${corectate.join(", ")}.)` : ""}`, corectate };
    corectate.push(x.palet);
  }
  return { corectate };
}

function piedica(vechi, nou) {
  if (!vechi || !nou) return "Unul dintre produse nu mai există sau a fost deja unificat.";
  if (Number(vechi.id) === Number(nou.id)) return "E același produs.";
  // Sensul contează: produsul cu cod nou e cel care rămâne.
  if (U.eNou(vechi) && !U.eNou(nou)) return "Produsul cu cod nou e cel care rămâne: nu se unifică el într-unul cu cod vechi. Alege-le invers.";
  if (eBun(vechi) && !eBun(nou)) return "Produsul trecut ca „E bun așa” e cel care rămâne: nu se unifică el într-unul cu cod vechi. Alege-le invers.";
  return "";
}

async function unifica(vechi, nou, user, fel) {
  const rt = await reteteleLor(vechi.id, nou.id);
  if (rt.vechi > 0 && rt.nou > 0) throw new Error(MESAJ_DOUA_RETETE);
  const r = await FZ.fuzioneaza(nou.id, [vechi.id], user ? user.id : null);
  const completate = await completeazaDinVechi(nou.id, vechi.id, { cuReteta: rt.vechi > 0 });
  // Rețeta s-a mutat (ca produs sau ca materie primă): costurile din rețete se
  // socotesc din nou, ca produsul păstrat să-și aibă costul și cel vechi nu.
  if (rt.vechi > 0 || Number(r.mutari["retete_componente.componenta_id"]) > 0) {
    await require("../lib/cost")
      .recalculeazaRetete()
      .catch((e) => console.error("[unificare-coduri] costurile din rețete nu s-au putut recalcula:", e.message));
  }
  await db
    .prepare(
      `INSERT INTO produse_asocieri (vechi_id, nou_id, stare, fel, nota, facut_de)
       VALUES (?, ?, 'unificata', ?, ?, ?)
       ON CONFLICT (vechi_id, nou_id) DO UPDATE SET stare = 'unificata', fel = EXCLUDED.fel, nota = EXCLUDED.nota, facut_de = EXCLUDED.facut_de,
         facut_la = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
    )
    .run(vechi.id, nou.id, fel || "de_mana", completate.length ? "completat din cel vechi: " + completate.join(", ") : null, user ? user.id : null);
  console.log(`[unificare-coduri] #${vechi.id} „${vechi.denumire}” → #${nou.id} „${nou.denumire}”: ${r.total} rânduri mutate (${(user && user.nume) || "?"})`);
  CV.goleste();
  const cazute = locuriCazute(r.mutari);
  if (cazute.length) console.error(`[unificare-coduri] #${vechi.id} → #${nou.id}: N-AU PUTUT FI MUTATE ${cazute.join(", ")}:`, JSON.stringify(r.mutari).slice(0, 600));
  return { total: r.total, mutari: r.mutari, completate, cazute };
}

function register(router) {
  router.get(CALE, async (ctx) => {
    const q = ctx.query || {};
    const d = await citeste();
    const s = socoteste(d);
    const parte = ["perechi", "vechi", "parcate"].includes(String(q.parte || "")) ? String(q.parte) : "stoc";
    const cauta = String(q.q || "").trim().slice(0, 80);
    const cuvinte = SP.cuvinte(cauta);
    const sePotriveste = (...texte) => {
      if (!cuvinte.length) return true;
      const t = SP.cuvinte(texte.join(" ")).join(" ");
      return cuvinte.every((c) => t.includes(c));
    };

    const mesaj =
      (q.ok ? `<div class="flash" role="status">${esc(String(q.ok))}</div>` : "") +
      (q.eroare ? `<div class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(q.eroare))}</div>` : "");

    const cuPropunere = s.cuStoc.filter((x) => x.propuneri.length).length;
    const carduri = `<div class="cards">
        <div class="card"><div class="label">Coduri bune</div><div class="value">${s.noi.length}</div><div class="ct-sub">din configurator sau trecute ca „E bun așa”</div></div>
        <div class="card"><div class="label">Produse vechi cu stoc</div><div class="value">${s.cuStoc.length}</div><div class="ct-sub">${cuPropunere} cu o propunere</div></div>
        <div class="card"><div class="label">Scrise de două ori, fără stoc</div><div class="value">${s.faraStoc.length}</div><div class="ct-sub">se unifică în bloc</div></div>
        <div class="card"><div class="label">Cod vechi, fără stoc</div><div class="value">${s.vechiFaraStoc.length}</div><div class="ct-sub">la alegere apar cu „nu selecta”</div></div>
        <div class="card"><div class="label">Parcate</div><div class="value">${s.parcate.length}</div><div class="ct-sub">nu mai apar la alegere</div></div>
      </div>`;
    const taburi = `<div class="subnav" style="margin:10px 0">
        <a href="${CALE}" class="subnav-link${parte === "stoc" ? " activ" : ""}">Produse vechi cu stoc (${s.cuStoc.length})</a>
        <a href="${CALE}?parte=perechi" class="subnav-link${parte === "perechi" ? " activ" : ""}">Scrise de două ori, fără stoc (${s.faraStoc.length})</a>
        <a href="${CALE}?parte=vechi" class="subnav-link${parte === "vechi" ? " activ" : ""}">Cod vechi, fără stoc (${s.vechiFaraStoc.length})</a>
        <a href="${CALE}?parte=parcate" class="subnav-link${parte === "parcate" ? " activ" : ""}">Parcate (${s.parcate.length})</a>
      </div>
      <form method="get" action="${CALE}" class="toolbar" style="margin:0 0 10px">
        ${parte !== "stoc" ? `<input type="hidden" name="parte" value="${parte}">` : ""}
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după denumire sau cod" style="min-width:280px">
        <button class="btn secondary" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary small" href="${CALE}${parte !== "stoc" ? "?parte=" + parte : ""}">Arată tot</a>` : ""}
      </form>`;

    let corp;
    if (parte === "stoc") {
      const randuri = s.cuStoc.filter((x) => sePotriveste(x.p.denumire, codulLui(x.p), ...x.propuneri.map((y) => `${y.nou.denumire} ${codulLui(y.nou)}`)));
      const optiuniNoi = s.noi.map((n) => `<option value="${esc(codulLui(n) || "#" + n.id)} — ${esc(String(n.denumire || "").slice(0, 90))}">`).join("");
      const felText = (y) =>
        y.fel === "pereche"
          ? y.sigura
            ? '<span class="badge verde">scris de două ori</span>'
            : '<span class="badge galben">același cod, altă denumire</span>'
          : y.fel === "de_mana"
            ? `<span class="badge albastru">asociat de ${esc(y.de || "cineva")}</span>`
            : `<span class="badge ${y.scor >= U.PRAG_BUN ? "verde" : "gri"}">seamănă · potrivire ${U.cuvantScor(y.scor)}</span>`;
      corp = `
        <p style="max-width:900px;color:var(--text-muted)">
          Produse cu cod vechi care au marfă în CT-Park. Lângă fiecare, produsul în care ar trebui să intre: fratele lui
          „scris de două ori”, ce a asociat un om, sau produsele cu cod nou care seamănă. Pașii merg în ordine, iar butoanele se aprind pe rând:
          <strong>1. codul nou</strong> (dacă nu există), <strong>2. asocierea</strong> (un om confirmă că e aceeași marfă, și la propunerile
          făcute de pagină), <strong>3. unificarea</strong>. <strong>„Unifică”</strong> arată
          întâi ce se mută și abia apoi mută: stocul, paleții, comenzile, facturile și rețetele trec pe produsul care rămâne,
          iar cel vechi dispare din liste. <strong>„Nu e același produs”</strong> scoate propunerea și n-o mai aduce.
          Dacă produsul n-are încă frate cu cod nou, apasă <strong>„Fă codul nou…”</strong>: configuratorul se deschide cu familia și
          caracteristicile citite din denumirea lui, codul iese după convenția nouă, iar după salvare produsul vechi e legat de cel nou.
        </p>
        <datalist id="produse-noi">${optiuniNoi}</datalist>
        ${
          randuri.length
            ? `<div class="tabel-scroll"><table class="table" data-unificare="stoc">
                <thead><tr><th>Produs vechi</th><th>Stoc în CT-Park</th><th>Unde ar trebui să intre</th><th></th></tr></thead>
                <tbody>${randuri
                  .map(
                    (x) => `<tr data-vechi="${x.p.id}">
                      <td style="white-space:normal;max-width:340px">${numeProdus(x.p)}<div style="font-size:12px;color:var(--text-muted)">UM ${esc(x.p.unitate_masura || "—")}</div></td>
                      <td>${stocText(x.stoc)}</td>
                      <td style="white-space:normal">${
                        x.propuneri.length
                          ? x.propuneri
                              .map(
                                (y) => `<div data-propunere="${y.nou.id}" style="margin:0 0 8px;padding:0 0 8px;border-bottom:1px dashed var(--border)">
                                  ${felText(y)} ${numeProdus(y.nou)}
                                  <div style="font-size:12px;color:var(--text-muted)">UM ${esc(y.nou.unitate_masura || "—")}${
                                    SP.normUm(y.nou.unitate_masura) !== SP.normUm(x.p.unitate_masura) ? ' · <strong style="color:var(--warn,#b5760b)">altă unitate decât cel vechi</strong>' : ""
                                  } · ${stocText(d.stoc.get(Number(y.nou.id)))}${y.motive && y.motive.length ? " · " + esc(y.motive.join("; ")) : ""}${
                                    y.altele ? ` · mai sunt ${y.altele} cu același cod` : ""
                                  }</div>
                                  <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center" data-pasi="${y.asociat ? "3" : "2"}">
                                    ${
                                      y.asociat
                                        ? `<span class="badge verde" title="Asociat de ${esc(y.de || "cineva")}">2. asociat ✓</span>
                                           <a class="btn small" href="${CALE}/unifica?vechi=${x.p.id}&amp;nou=${y.nou.id}">3. Unifică…</a>`
                                        : `<form method="post" action="${CALE}/asociaza" class="inline-form">
                                             <input type="hidden" name="vechi_id" value="${x.p.id}"><input type="hidden" name="nou" value="#${y.nou.id}">
                                             <button class="btn small" type="submit" title="Confirmi că e aceeași marfă. Abia apoi se poate unifica.">2. E același produs — asociază</button>
                                           </form>
                                           <button class="btn small" type="button" disabled data-unifica-stins title="Întâi pasul 2: asociază">3. Unifică…</button>`
                                    }
                                    <form method="post" action="${CALE}/respinge" class="inline-form">
                                      <input type="hidden" name="vechi_id" value="${x.p.id}"><input type="hidden" name="nou_id" value="${y.nou.id}">
                                      <button class="btn secondary small" type="submit">Nu e același produs</button>
                                    </form>
                                  </div>
                                </div>`
                              )
                              .join("")
                          : '<span style="color:var(--text-muted)">Nicio propunere. Asociază-l de mână, în dreapta.</span>'
                      }</td>
                      <td style="white-space:normal;min-width:260px">
                        <form method="post" action="${CALE}/asociaza" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                          <input type="hidden" name="vechi_id" value="${x.p.id}">
                          <input name="nou" list="produse-noi" placeholder="cod nou sau #id" autocomplete="off" style="width:170px" aria-label="Produsul în care intră">
                          <button class="btn secondary small" type="submit">2. Asociază</button>
                        </form>
                        <div style="margin-top:6px">
                          <a class="btn secondary small" data-fa-cod-nou href="/produse/nou-cu-cod?din=${x.p.id}" title="Deschide configuratorul cu familia și caracteristicile citite din denumire: codul iese după convenția nouă">1. Fă codul nou…</a>
                        </div>
                        <form method="post" action="${CALE}/excepta" class="inline-form" style="margin-top:6px"
                              onsubmit="return confirm('Produsul rămâne cum e și iese din lista asta. Continui?')">
                          <input type="hidden" name="produs_id" value="${x.p.id}"><input type="hidden" name="pe" value="1">
                          <button class="link-btn" type="submit" title="Nu e un produs de unificat: transport, serviciu, marfă care n-are familie">E bun așa, scoate-l din listă</button>
                        </form>
                      </td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table></div>`
            : `<p>${cauta ? "Nimic nu se potrivește cu ce ai căutat." : "Niciun produs cu cod vechi nu mai are stoc în CT-Park."}</p>`
        }
        ${
          s.exceptate.length
            ? `<details data-exceptate style="margin-top:14px;max-width:900px">
                <summary style="cursor:pointer">Scoase din listă cu „E bun așa” (${s.exceptate.length})</summary>
                ${table(
                  ["Produs", "Stoc în CT-Park", ""],
                  s.exceptate.map((x) => [
                    numeProdus(x),
                    stocText(d.stoc.get(Number(x.id))),
                    `<form method="post" action="${CALE}/excepta" class="inline-form">
                       <input type="hidden" name="produs_id" value="${x.id}"><input type="hidden" name="pe" value="0">
                       <button class="btn secondary small" type="submit">Repune în listă</button>
                     </form>`,
                  ])
                )}
              </details>`
            : ""
        }`;
    } else if (parte === "vechi" || parte === "parcate") {
      const parcat = parte === "parcate";
      const folosit = await CV.folosite().catch(() => new Map());
      const toate = (parcat ? s.parcate : s.vechiFaraStoc).filter((x) => sePotriveste(x.denumire, codulLui(x)));
      const pagina = toate.slice(0, PE_PAGINA);
      const ziRo = (z) => (z ? `${z.slice(8, 10)}.${z.slice(5, 7)}.${z.slice(0, 4)}` : "");
      corp = `
        <p style="max-width:900px;color:var(--text-muted)">${
          parcat
            ? `Produse cu cod vechi, fără stoc, nefolosite de ${CV.ZILE} de zile. <strong>Nu mai apar la alegerea produsului</strong> (comenzi, oferte, comenzi la furnizori, producție, recepție, facturi). Rămân în nomenclator și pe documentele vechi. „Scoate din parcare” le aduce înapoi la alegere.`
            : `Produse cu cod vechi care n-au marfă în CT-Park. La alegerea produsului apar cu <strong>„${esc(CV.ETICHETA)}”</strong>. Cele nefolosite ${CV.ZILE} de zile (pe nicio comandă, ofertă, factură, recepție sau palet) se parchează singure, în fiecare noapte, începând cu ${ziRo(CV.PARCARE_DE_LA)}. Dacă un produs de aici e de fapt bun, deschide-i fișa sau trece-l ca „E bun așa” de mai jos.`
        }</p>
        ${
          pagina.length
            ? `<div class="tabel-scroll"><table class="table" data-unificare="${parte}">
                <thead><tr><th>Produs</th><th>UM</th><th>Folosit ultima dată</th>${parcat ? "<th>Parcat</th>" : ""}<th></th></tr></thead>
                <tbody>${pagina
                  .map(
                    (x) => `<tr data-produs="${x.id}">
                      <td style="white-space:normal">${numeProdus(x)}</td>
                      <td>${esc(x.unitate_masura || "—")}</td>
                      <td>${folosit.get(Number(x.id)) ? esc(ziRo(folosit.get(Number(x.id)))) : '<span style="color:var(--text-muted)">niciodată</span>'}</td>
                      ${parcat ? `<td>${esc(ziRo(String(x.parcat_la).slice(0, 10)))}${x.parcat_fel === "mana" ? " · de mână" : ""}</td>` : ""}
                      <td style="white-space:nowrap">
                        <form method="post" action="${CALE}/parcare" class="inline-form">
                          <input type="hidden" name="produs_id" value="${x.id}"><input type="hidden" name="pe" value="${parcat ? "0" : "1"}">
                          <button class="btn secondary small" type="submit">${parcat ? "Scoate din parcare" : "Parchează"}</button>
                        </form>
                        ${
                          parcat
                            ? ""
                            : `<form method="post" action="${CALE}/excepta" class="inline-form">
                                 <input type="hidden" name="produs_id" value="${x.id}"><input type="hidden" name="pe" value="1"><input type="hidden" name="inapoi" value="vechi">
                                 <button class="link-btn" type="submit" title="Codul lui e bun: nu mai e socotit cod vechi">E bun așa</button>
                               </form>`
                        }
                      </td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table></div>
              <p style="font-size:13px;color:var(--text-muted)">${toate.length > pagina.length ? `Primele ${pagina.length} din ${toate.length}. Caută după denumire sau cod ca să ajungi la celelalte.` : `${toate.length} ${toate.length === 1 ? "produs" : "produse"}.`}</p>`
            : `<p>${cauta ? "Nimic nu se potrivește cu ce ai căutat." : parcat ? "Niciun produs parcat." : "Niciun produs cu cod vechi fără stoc."}</p>`
        }`;
    } else {
      const toate = s.faraStoc.filter((x) => sePotriveste(x.vechi.denumire, x.nou.denumire, codulLui(x.nou)));
      const pagina = toate.slice(0, PE_PAGINA);
      corp = `
        <p style="max-width:900px;color:var(--text-muted)">
          Același produs scris de două ori: o dată „Denumire (COD)”, fără cod, și o dată cu codul în câmpul lui. Rămâne
          cel cu codul; cel fără cod se unifică în el, cu tot ce ține de el (linii de comandă și de factură, rețete).
          Aici sunt doar perechile la care produsul fără cod <strong>n-are stoc</strong>; cele cu stoc sunt în prima listă,
          una câte una. Bifează-le pe cele bune și apasă o dată. La „același cod, altă denumire” uită-te înainte să bifezi.
        </p>
        ${
          pagina.length
            ? `<form method="post" action="${CALE}/perechi" onsubmit="return confirm('Unific perechile bifate? Produsele fără cod dispar din liste; rămân în bază, legate de cel păstrat.')">
                ${cauta ? `<input type="hidden" name="q" value="${esc(cauta)}">` : ""}
                <div class="tabel-scroll"><table class="table" data-unificare="perechi">
                  <thead><tr><th><input type="checkbox" id="bifa-toate" aria-label="Bifează toate perechile sigure de pe pagină"></th>
                    <th>Produsul fără cod (dispare)</th><th>Produsul cu codul (rămâne)</th><th>Cât de sigur</th></tr></thead>
                  <tbody>${pagina
                    .map(
                      (x) => `<tr>
                        <td><input type="checkbox" name="pereche" value="${x.vechi.id}:${x.nou.id}"${x.sigura && !x.altele ? ' data-sigura="1"' : ""}></td>
                        <td style="white-space:normal">${numeProdus(x.vechi)}</td>
                        <td style="white-space:normal">${numeProdus(x.nou)} <span style="font-size:12px;color:var(--text-muted)">${stocText(d.stoc.get(Number(x.nou.id)))}</span></td>
                        <td>${
                          x.sigura && !x.altele
                            ? '<span class="badge verde">aceeași denumire</span>'
                            : x.sigura
                              ? `<span class="badge galben">aceeași denumire, dar mai sunt ${x.altele} cu codul ăsta</span>`
                              : '<span class="badge galben">același cod, altă denumire</span>'
                        }</td>
                      </tr>`
                    )
                    .join("")}</tbody>
                </table></div>
                <div class="form-actions" style="margin-top:10px">
                  <button class="btn" type="submit">Unifică perechile bifate</button>
                  <span style="font-size:13px;color:var(--text-muted)">${
                    toate.length > pagina.length ? `Primele ${pagina.length} din ${toate.length}. După unificare apar următoarele.` : `${toate.length} ${toate.length === 1 ? "pereche" : "perechi"}.`
                  }</span>
                </div>
              </form>
              <script>
                (function () {
                  var tot = document.getElementById("bifa-toate");
                  if (!tot) return;
                  tot.addEventListener("change", function () {
                    document.querySelectorAll('input[name="pereche"][data-sigura]').forEach(function (b) { b.checked = tot.checked; });
                  });
                })();
              </script>`
            : `<p>${cauta ? "Nimic nu se potrivește cu ce ai căutat." : "Nicio pereche fără stoc de unificat."}</p>`
        }`;
    }

    const facute = await db
      .prepare(
        `SELECT f.facut_la, f.pastrat_id, f.inghitit_cod, f.inghitit_denumire, p.cod AS pastrat_cod, p.denumire AS pastrat_denumire, u.nume AS de
           FROM produse_fuziuni f LEFT JOIN produse p ON p.id = f.pastrat_id LEFT JOIN utilizatori u ON u.id = f.facut_de
          ORDER BY f.id DESC LIMIT 15`
      )
      .all()
      .catch(() => []);
    const istoric = facute.length
      ? `<h2 style="margin-top:28px">Ultimele unificări</h2>
         ${table(
           ["Când", "A dispărut", "A rămas", "Cine"],
           facute.map((f) => [
             esc(String(f.facut_la || "").slice(0, 16)),
             `${f.inghitit_cod ? `<code>${esc(f.inghitit_cod)}</code> ` : ""}${esc(f.inghitit_denumire || "")}`,
             `${f.pastrat_cod ? `<code>${esc(f.pastrat_cod)}</code> ` : ""}<a href="/produse/${f.pastrat_id}">${esc(f.pastrat_denumire || "#" + f.pastrat_id)}</a>`,
             esc(f.de || "—"),
           ])
         )}
         <p style="font-size:12px;color:var(--text-muted)">Toate, cu ce s-a mutat la fiecare: <a href="/produse/fuziune">Unificări făcute</a>.</p>`
      : "";

    const body = `
      ${subnav(CALE)}
      ${mesaj}
      ${carduri}
      ${taburi}
      ${corp}
      ${istoric}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Configurări · Unificare coduri", active: CALE, body }));
  });

  // Ce se mută, înainte să se mute.
  router.get(`${CALE}/unifica`, async (ctx) => {
    const d = await citeste();
    const vechi = d.dupaId.get(idDin(ctx.query.vechi));
    const nou = d.dupaId.get(idDin(ctx.query.nou));
    const p = piedica(vechi, nou) || neasociat(d, vechi, nou);
    if (p) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent(p)}`);
    const prev = await FZ.previzualizeaza(nou.id, [vechi.id]);
    const paleti = await paletiiLor(vechi.id, nou.id);
    const rt = await reteteleLor(vechi.id, nou.id);
    const douaRetete = rt.vechi > 0 && rt.nou > 0;
    // Doar ce chiar se mută: motorul întoarce și tabelele cu zero rânduri.
    const deMutat = prev.randuri.filter((r) => r.eroare || Number(r.muta) > 0 || Number(r.blocat) > 0);
    const sv = d.stoc.get(Number(vechi.id));
    const sn = d.stoc.get(Number(nou.id));
    const altaUm = SP.normUm(vechi.unitate_masura) !== SP.normUm(nou.unitate_masura);
    const cutie = (titlu, x, s) => `<div class="detail-box" style="flex:1 1 320px">
        <div style="color:var(--text-muted);font-size:12px">${titlu}</div>
        <div style="font-size:15px;margin:4px 0">${numeProdus(x)}</div>
        <div style="font-size:13px;color:var(--text-muted)">UM ${esc(x.unitate_masura || "—")} · ${U.eNou(x) ? "cod nou" : "cod vechi"} · stoc: ${stocText(s)}</div>
      </div>`;
    const body = `
      ${subnav(CALE)}
      <div style="display:flex;gap:14px;flex-wrap:wrap;max-width:980px">
        ${cutie("Dispare din liste", vechi, sv)}
        ${cutie("Rămâne", nou, sn)}
      </div>
      ${
        altaUm
          ? `<div class="flash flash-rosu" role="alert" style="max-width:980px">Cele două produse au unități diferite (${esc(vechi.unitate_masura || "—")} și ${esc(
              nou.unitate_masura || "—"
            )}). Marfa de pe paleți rămâne în unitatea în care e scrisă; uită-te dacă e chiar același produs.</div>`
          : ""
      }
      ${douaRetete ? `<div class="flash flash-rosu" role="alert" data-doua-retete style="max-width:980px;background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(MESAJ_DOUA_RETETE)}</div>` : ""}
      <h2>Ce se mută pe produsul care rămâne</h2>
      ${
        deMutat.length
          ? table(
              ["Ce", "Rânduri care se mută", "Rămân pe cel vechi"],
              deMutat.map((r) => [
                esc(NUME_TABEL[r.cheie] || r.cheie),
                r.eroare ? `<span style="color:var(--danger)">${esc(r.eroare)}</span>` : String(r.muta),
                Number(r.blocat) > 0 ? `<strong>${Number(r.blocat)}</strong>` : "—",
              ]),
              { total: ["Total", String(prev.total), prev.blocate ? String(prev.blocate) : "—"] }
            )
          : "<p>Produsul vechi nu e folosit nicăieri: se scoate doar din liste.</p>"
      }
      ${
        prev.blocate
          ? `<p style="color:var(--warn,#b5760b);max-width:900px"><strong>${prev.blocate} rânduri rămân pe produsul vechi</strong>: produsul care rămâne are deja rândul lui în același loc (același inventar, aceeași caracteristică sau același lot).</p>`
          : ""
      }
      <p style="max-width:900px;font-size:13px;color:var(--text-muted)">
        Produsul vechi nu se șterge: rămâne în bază, dezactivat și legat de cel păstrat, ca facturile și avizele vechi să
        arate ce au arătat. Câmpurile goale ale celui păstrat se completează din cel vechi: prețurile, costul de
        producție și stocul minim (doar la aceeași unitate), adaosul propriu, costul real din contabilitate, categoria,
        gestiunea, furnizorul, iar când rețeta vine de la el, și baza ei cu fluxul de producție.
        Unificarea nu se poate desface din pagină.
      </p>
      <form method="post" action="${CALE}/unifica" onsubmit="return confirm('Unific? Produsul vechi dispare din liste, iar tot ce ține de el trece pe celălalt.')">
        <input type="hidden" name="vechi_id" value="${vechi.id}"><input type="hidden" name="nou_id" value="${nou.id}">
        ${ctx.query.eroare ? `<div class="flash flash-rosu" role="alert" style="max-width:980px;background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(ctx.query.eroare))}</div>` : ""}
        ${
          paleti.length
            ? `<h2>Cantitatea după verificare</h2>
               <p style="max-width:900px;font-size:13px;color:var(--text-muted)">
                 Marfa celor două produse, palet cu palet. Propus e ce scrie acum în sistem (totalul = suma). Dacă la numărare a ieșit altceva,
                 schimbă cantitatea pe paletul respectiv: se corectează la unificare, cu urmă în istoricul paletului.
               </p>
               <div class="tabel-scroll"><table class="table" data-paleti-unificare style="max-width:760px">
                 <thead><tr><th>Palet</th><th>Acum pe</th><th>În sistem</th><th>Numărat</th></tr></thead>
                 <tbody>${paleti
                   .map(
                     (l) => `<tr>
                       <td><a href="/stocuri/ct-park/palet/${l.palet_id}" target="_blank" rel="noopener">${esc(l.palet)}</a></td>
                       <td>${Number(l.produs_id) === Number(vechi.id) ? "produsul vechi" : "produsul care rămâne"}</td>
                       <td>${esc(cant(l.cantitate))} ${esc(l.um || "")}</td>
                       <td><input type="text" inputmode="decimal" name="cant_${l.linie_id}" value="${esc(String(nr(l.cantitate)))}" data-cant-sistem="${nr(l.cantitate)}" style="width:110px" aria-label="Cantitatea numărată pe ${esc(l.palet)}"> ${esc(l.um || "")}</td>
                     </tr>`
                   )
                   .join("")}</tbody>
                 <tfoot><tr style="font-weight:600"><td colspan="2">Total după unificare</td><td>${esc(cant(paleti.reduce((a, l) => a + nr(l.cantitate), 0)))}</td><td><span data-total-numarat>${esc(cant(paleti.reduce((a, l) => a + nr(l.cantitate), 0)))}</span> <span data-total-diferenta style="font-weight:400;color:var(--warn,#b5760b)"></span></td></tr></tfoot>
               </table></div>
               ${(sv && sv.dePus > SP.EPS) || (sn && sn.dePus > SP.EPS) ? `<p style="font-size:13px;color:var(--text-muted)">Pe lângă paleți, mai e marfă recepționată și încă nepusă pe raft; ea se numără când se pune pe palet.</p>` : ""}
               <script>
                 (function () {
                   var t = document.querySelector("[data-paleti-unificare]");
                   if (!t) return;
                   var nr = function (v) { var n = Number(String(v).trim().split(" ").join("").replace(",", ".")); return isFinite(n) && n >= 0 ? n : NaN; };
                   var ro = function (x) { return x.toLocaleString("ro-RO", { maximumFractionDigits: 3 }); };
                   var refa = function () {
                     var s = 0, sis = 0, rau = false;
                     t.querySelectorAll("input[data-cant-sistem]").forEach(function (i) { var n = nr(i.value); if (isNaN(n)) rau = true; else s += n; sis += Number(i.getAttribute("data-cant-sistem")); });
                     t.querySelector("[data-total-numarat]").textContent = rau ? "—" : ro(s);
                     var d = s - sis;
                     t.querySelector("[data-total-diferenta]").textContent = rau ? "o cantitate nu e număr" : Math.abs(d) < 0.0005 ? "" : "(" + (d > 0 ? "+" : "") + ro(d) + " față de sistem)";
                   };
                   t.addEventListener("input", refa);
                 })();
               </script>`
            : ""
        }
        <div class="form-actions">
          ${douaRetete ? "" : '<button class="btn" type="submit">Unifică</button>'}
          <a class="btn secondary" href="${CALE}">${douaRetete ? "Înapoi" : "Renunță"}</a>
        </div>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Unificare coduri · ce se mută", active: CALE, body }));
  });

  router.post(`${CALE}/unifica`, async (ctx) => {
    const d = await citeste();
    const vechi = d.dupaId.get(idDin(ctx.body.vechi_id));
    const nou = d.dupaId.get(idDin(ctx.body.nou_id));
    const p = piedica(vechi, nou) || neasociat(d, vechi, nou);
    if (p) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent(p)}`);
    // Cantitățile numărate la verificare: se corectează paleții ÎNAINTE de
    // unificare, ca o cantitate greșită să oprească tot, nu să rămână pe jumătate.
    const numarat = await corecteazaPaletii(vechi, nou, ctx.body, ctx.user);
    if (numarat.eroare) return redirect(ctx.res, `${CALE}/unifica?vechi=${vechi.id}&nou=${nou.id}&eroare=${encodeURIComponent(numarat.eroare)}`);
    let r;
    try {
      r = await unifica(vechi, nou, ctx.user, "validata");
    } catch (e) {
      console.error("[unificare-coduri] unificarea a căzut:", e.message);
      return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Unificarea n-a mers: " + String(e.message).slice(0, 300))}`);
    }
    const text = `„${vechi.denumire}” a intrat în ${codulLui(nou) ? codulLui(nou) + " · " : ""}„${nou.denumire}”: ${r.total} ${r.total === 1 ? "rând mutat" : "rânduri mutate"}${
      r.completate.length ? "; completat din cel vechi: " + r.completate.join(", ") : ""
    }${numarat.corectate.length ? `; cantitate corectată după numărare pe ${numarat.corectate.join(", ")}` : ""}.`;
    if (r.cazute.length) {
      const ramase = ` Atenție: n-au putut fi mutate: ${r.cazute.join(", ")}. Au rămas pe produsul vechi — anunță-l pe Vali, cu numele produsului.`;
      return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent((text.slice(0, 500) + ramase).slice(0, 900))}`);
    }
    redirect(ctx.res, `${CALE}?ok=${encodeURIComponent(text.slice(0, 600))}`);
  });

  // „Nu e același produs": perechea nu se mai propune.
  router.post(`${CALE}/respinge`, async (ctx) => {
    const vechi = idDin(ctx.body.vechi_id);
    const nou = idDin(ctx.body.nou_id);
    if (!vechi || !nou || vechi === nou) return redirect(ctx.res, CALE);
    await db
      .prepare(
        `INSERT INTO produse_asocieri (vechi_id, nou_id, stare, fel, facut_de) VALUES (?, ?, 'respinsa', 'de_mana', ?)
         ON CONFLICT (vechi_id, nou_id) DO UPDATE SET stare = 'respinsa', facut_de = EXCLUDED.facut_de, facut_la = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
      )
      .run(vechi, nou, ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `${CALE}?ok=${encodeURIComponent("Am notat: nu e același produs. Propunerea nu mai apare.")}`);
  });

  // Asocierea de mână: produsul vechi cu unul ales după cod (sau „#id"). Doar
  // se propune; unificarea rămâne de validat.
  router.post(`${CALE}/asociaza`, async (ctx) => {
    const d = await citeste();
    const vechi = d.dupaId.get(idDin(ctx.body.vechi_id));
    const scris = String(ctx.body.nou || "").trim();
    const inapoi = (cheie, text) => redirect(ctx.res, `${CALE}?${cheie}=${encodeURIComponent(text)}`);
    if (!vechi) return inapoi("eroare", "Produsul vechi nu mai există sau a fost deja unificat.");
    if (!scris) return inapoi("eroare", "Scrie codul produsului în care intră, sau #id.");
    // Din listă vine „COD — denumire"; scris de mână poate fi doar codul sau „#id".
    const cap = scris.split(" — ")[0].trim();
    const dupaNumar = /^#\d+$/.test(cap) ? d.dupaId.get(idDin(cap.slice(1))) : null;
    const cheieCod = U.cheie(cap);
    const cuCodul = dupaNumar ? [dupaNumar] : d.produse.filter((p) => cheieCod && (U.cheie(p.cod) === cheieCod || U.cheie(p.cod_generat) === cheieCod));
    if (!cuCodul.length) return inapoi("eroare", `Niciun produs activ cu codul „${cap}”.`);
    if (cuCodul.length > 1) return inapoi("eroare", `Sunt ${cuCodul.length} produse cu codul „${cap}”. Scrie-l cu #id (îl vezi în adresa fișei produsului).`);
    const nou = cuCodul[0];
    const p = piedica(vechi, nou);
    if (p) return inapoi("eroare", p);
    await db
      .prepare(
        `INSERT INTO produse_asocieri (vechi_id, nou_id, stare, fel, facut_de) VALUES (?, ?, 'propusa', 'de_mana', ?)
         ON CONFLICT (vechi_id, nou_id) DO UPDATE SET stare = 'propusa', fel = 'de_mana', facut_de = EXCLUDED.facut_de, facut_la = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
      )
      .run(vechi.id, nou.id, ctx.user ? ctx.user.id : null);
    inapoi("ok", `„${vechi.denumire}” e asociat cu ${codulLui(nou) ? codulLui(nou) + " · " : ""}„${nou.denumire}”. Unificarea rămâne de validat, cu „Unifică…”.`);
  });

  // „E bun așa": produsul iese din lista celor de unificat (și se poate repune).
  router.post(`${CALE}/excepta`, async (ctx) => {
    const id = idDin(ctx.body.produs_id);
    const pe = String(ctx.body.pe) === "0" ? 0 : 1;
    if (!id) return redirect(ctx.res, CALE);
    const p = await db.prepare("SELECT id, denumire FROM produse WHERE id = ?").get(id);
    if (!p) return redirect(ctx.res, CALE);
    await db.prepare("UPDATE produse SET cod_vechi_exceptat = ? WHERE id = ?").run(pe, id);
    CV.goleste();
    console.log(`[unificare-coduri] #${id} „${p.denumire}”: ${pe ? "scos din lista de unificat" : "repus în lista de unificat"} (${(ctx.user && ctx.user.nume) || "?"})`);
    redirect(ctx.res, `${CALE}?${String(ctx.body.inapoi) === "vechi" ? "parte=vechi&" : ""}ok=${encodeURIComponent(pe ? `„${p.denumire}” rămâne cum e și a ieșit din listă.` : `„${p.denumire}” e din nou în listă.`)}`);
  });

  // Parcarea de mână și scoaterea din parcare. Se parchează doar un produs cu
  // cod vechi fără stoc: unul cu marfă trebuie să poată fi vândut.
  router.post(`${CALE}/parcare`, async (ctx) => {
    const id = idDin(ctx.body.produs_id);
    const pe = String(ctx.body.pe) === "0" ? 0 : 1;
    const d = await citeste();
    const p = d.dupaId.get(id);
    const inapoi = (parte, cheie, text) => redirect(ctx.res, `${CALE}?parte=${parte}&${cheie}=${encodeURIComponent(text)}`);
    if (!p) return inapoi(pe ? "vechi" : "parcate", "eroare", "Produsul nu mai există sau a fost unificat.");
    if (!pe) {
      await CV.scoateDinParcare(id);
      console.log(`[unificare-coduri] #${id} „${p.denumire}”: scos din parcare (${(ctx.user && ctx.user.nume) || "?"})`);
      return inapoi("parcate", "ok", `„${p.denumire}” a ieșit din parcare și apare din nou la alegere.`);
    }
    if (eBun(p)) return inapoi("vechi", "eroare", "Produsul are cod bun: nu se parchează.");
    if (d.stoc.has(id)) return inapoi("vechi", "eroare", "Produsul are stoc în CT-Park: nu se parchează. Locul lui e în lista de unificat.");
    await CV.parcheazaDeMana(id);
    console.log(`[unificare-coduri] #${id} „${p.denumire}”: parcat de mână (${(ctx.user && ctx.user.nume) || "?"})`);
    inapoi("vechi", "ok", `„${p.denumire}” e parcat: nu mai apare la alegerea produsului.`);
  });

  // Unificarea în bloc a perechilor „scrise de două ori", fără stoc. Fiecare
  // pereche se verifică din nou aici (pagina poate fi veche): trebuie să mai
  // fie o pereche, iar produsul fără cod să nu fi primit între timp stoc.
  router.post(`${CALE}/perechi`, async (ctx) => {
    const cerute = lista(ctx.body.pereche)
      .map((x) => String(x).split(":").map(idDin))
      .filter((x) => x.length === 2 && x[0] && x[1]);
    const inapoi = (cheie, text) => redirect(ctx.res, `${CALE}?parte=perechi&${cheie}=${encodeURIComponent(text)}`);
    if (!cerute.length) return inapoi("eroare", "N-ai bifat nicio pereche.");
    const d = await citeste();
    const bune = new Map(socoteste(d).faraStoc.map((x) => [`${x.vechi.id}:${x.nou.id}`, x]));
    const start = Date.now();
    let facute = 0;
    let sarite = 0;
    let ramase = 0;
    const cazute = [];
    const cuRanduriRamase = [];
    for (const [v, n] of cerute) {
      if (Date.now() - start > BUGET_MS) {
        ramase++;
        continue;
      }
      const x = bune.get(`${v}:${n}`);
      if (!x) {
        sarite++;
        continue;
      }
      try {
        const u = await unifica(x.vechi, x.nou, ctx.user, "pereche");
        facute++;
        if (u.cazute.length) cuRanduriRamase.push(`${x.vechi.denumire} (${u.cazute.join(", ")})`);
      } catch (e) {
        console.error(`[unificare-coduri] perechea ${v}:${n} a căzut:`, e.message);
        cazute.push(`${x.vechi.denumire} (${e.message === MESAJ_DOUA_RETETE ? "amândouă au rețetă — unifică-le una câte una, după ce rămâne o singură rețetă" : String(e.message).slice(0, 120)})`);
      }
    }
    const bucati = [`${facute} ${facute === 1 ? "pereche unificată" : "perechi unificate"}`];
    if (sarite) bucati.push(`${sarite} sărite (nu mai sunt perechi fără stoc — pagina era veche)`);
    if (ramase) bucati.push(`${ramase} au rămas pentru apăsarea următoare (a trecut timpul)`);
    if (cazute.length) bucati.push(`${cazute.length} n-au mers: ${cazute.slice(0, 5).join("; ")}`);
    if (cuRanduriRamase.length) bucati.push(`${cuRanduriRamase.length} cu rânduri rămase pe produsul vechi: ${cuRanduriRamase.slice(0, 5).join("; ")}`);
    inapoi(cazute.length || cuRanduriRamase.length || (!facute && sarite) ? "eroare" : "ok", (bucati.join("; ") + ".").slice(0, 900));
  });
}

module.exports = { register, CALE, subnav, citeste, socoteste, completeazaDinVechi, piedica, MESAJ_DOUA_RETETE, eBun };
