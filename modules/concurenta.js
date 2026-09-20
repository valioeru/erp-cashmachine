"use strict";
// Prețurile concurenței — BI de piață, ținut lângă ofertele la care se află.
//
// De ce un singur tabel pentru două lucruri care par diferite:
// la vânzare, „concurentul" e firma care ofertează același client ca noi;
// la achiziție, e firma care ia de la același furnizor. Întrebările sunt însă
// identice — cine, ce produs, ce preț, la ce dată — iar raportul pe care îl
// vrea managementul le pune oricum cap la cap. Le-am despărțit printr-o
// coloană (directie), nu prin două tabele care ar fi divergat.
//
// Regula care ține datele curate: un preț fără dată nu e informație, e barfă.
// De-aia data ofertei e obligatorie și e data la care ȘTIM că prețul era
// valabil, nu ziua în care l-a scris cineva în ERP.
//
// Cine vede ce:
//   - agentul de vânzări        → /crm/concurenta       (doar vânzare)
//   - omul de la procurement    → /procurement/concurenta (doar achiziție)
//   - managementul              → /rapoarte/concurenta   (amândouă, cu istoric)
// Sunt trei rute fiindcă zonele de meniu sunt trei, dar raportul e unul
// singur, construit într-un loc — altfel cele trei ar fi spus trei adevăruri.
const db = require("../lib/db");
const { esc, money, layout, table, dataRo, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const CURS_IMPLICIT = 5.25;

function azi() {
  return new Date().toISOString().slice(0, 10);
}

async function cursEur() {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'ach_curs_eur'").get();
    const v = Number(r && r.valoare);
    return v > 0 ? v : CURS_IMPLICIT;
  } catch (e) {
    return CURS_IMPLICIT;
  }
}

// Totul se compară în lei. Prețurile vin în lei sau în euro (uneori în dolari,
// la marfa din Asia), iar un tabel în care coloana „preț" amestecă monede nu se
// poate citi. Cursul e cel setat în Procurement, ca să nu fie două cursuri în
// aceeași aplicație.
function inLei(pret, moneda, c) {
  const p = Number(pret) || 0;
  const m = String(moneda || "RON").toUpperCase();
  if (m === "EUR") return p * c;
  if (m === "USD") return p * c * 0.92;
  return p;
}

const MONEDE = ["RON", "EUR", "USD"];
const SURSE = [
  ["client", "de la client"],
  ["furnizor", "de la furnizor"],
  ["email", "email primit"],
  ["site", "site / listă de prețuri"],
  ["targ", "târg / întâlnire"],
  ["zvon", "auzit în piață"],
  ["alta", "altă sursă"],
];
const ETICHETA_SURSA = Object.fromEntries(SURSE);

function normalizeaza(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Cine are voie să șteargă un rând: cel care l-a scris sau administratorul.
// Oricine poate ADĂUGA — informația de piață se pierde dacă omul trebuie să
// ceară voie ca s-o scrie.
function poateSterge(user, rand) {
  if (!user) return false;
  if (user.rol === "admin") return true;
  return Number(rand.creat_de) === Number(user.id);
}

// ---------------------------------------------------------------------------
// Blocul care se pune pe pagina unei ofertări (de vânzare sau de achiziție).
// Îl cheamă modulul de oferte și cel de procurement, ca să nu existe două
// formulare care scriu în același tabel altfel.
//
// „referinte" sunt prețurile NOASTRE pentru aceleași produse, ca omul să vadă
// diferența pe loc, nu după ce deschide alt raport. La vânzare sunt liniile
// ofertei; la achiziție, ofertele primite pe articolul respectiv.
// ---------------------------------------------------------------------------
// ---- ce știm despre piață, pe produs ---------------------------------------
//
// Cererea lui Vali: „când ofertează un anume produs, agentului i se afișează
// în timp real ultimele prețuri ofertate de concurenți și la ce dată pe acel
// produs". Deci NU prețurile agățate de oferta curentă (alea le arată blocBI),
// ci tot ce știm despre produsul ăla, din orice ofertă, de la oricine.
//
// Se întoarce o hartă, nu HTML: pagina de ofertare o trimite o dată, ca date,
// și o folosește la fiecare schimbare de produs fără să mai întrebe serverul.
// De-aia „în timp real" chiar înseamnă pe loc, nu după o reîncărcare.
//
// Potrivirea se face pe două chei, în ordinea încrederii: produs_id, când
// prețul a fost scris pe un produs din nomenclator, și denumirea normalizată,
// când a fost scris liber — la telefon nu scrie nimeni codul produsului.
async function ultimelePeProdus(opts) {
  const o = opts || {};
  const directie = o.directie === "achizitie" ? "achizitie" : "vanzare";
  const cate = Math.max(1, Math.min(10, Number(o.cate) || 3));

  const randuri = await db
    .prepare(
      `SELECT c.produs_id, c.denumire, c.concurent, c.pret, c.moneda, c.um, c.data_ofertei,
              p.denumire AS produs_nume
         FROM concurenta_preturi c
         LEFT JOIN produse p ON p.id = c.produs_id
        WHERE c.activ = 1 AND c.directie = ?
        ORDER BY c.data_ofertei DESC, c.id DESC
        LIMIT 3000`
    )
    .all(directie)
    .catch(() => []);

  // Prețurile scrise liber, fără produs din nomenclator, trebuie să ajungă tot
  // la produsul lor. Altfel prețul aflat la târg — unde nimeni nu deschide
  // ERP-ul ca să aleagă produsul din listă — rămâne invizibil exact la
  // ofertarea produsului ăluia. Puntea e denumirea normalizată.
  const produse = await db
    .prepare("SELECT id, denumire FROM produse LIMIT 20000")
    .all()
    .catch(() => []);
  const numeCatreId = new Map();
  for (const p of produse) {
    const k = normalizeaza(p.denumire);
    // La denumiri duplicate nu ghicim: rândul rămâne doar sub nume.
    if (numeCatreId.has(k)) numeCatreId.set(k, null);
    else numeCatreId.set(k, Number(p.id));
  }

  const peProdus = {};
  const peNume = {};
  const pune = (cos, cheie, r) => {
    if (!cheie) return;
    if (!cos[cheie]) cos[cheie] = [];
    if (cos[cheie].length >= cate) return;
    cos[cheie].push({
      concurent: String(r.concurent || "—"),
      pret: Number(r.pret) || 0,
      moneda: String(r.moneda || "RON"),
      um: r.um ? String(r.um) : "",
      data: String(r.data_ofertei || "").slice(0, 10),
    });
  };
  // Rândurile vin deja în ordinea datei descrescătoare, deci primele puse
  // sunt cele mai noi — exact ce trebuie arătat.
  for (const r of randuri) {
    const cheieNume = normalizeaza(r.produs_nume || r.denumire);
    const id = r.produs_id ? Number(r.produs_id) : numeCatreId.get(cheieNume);
    if (id) pune(peProdus, String(id), r);
    pune(peNume, cheieNume, r);
  }
  return { peProdus, peNume };
}

async function blocBI(opts) {
  const o = opts || {};
  const directie = o.directie === "achizitie" ? "achizitie" : "vanzare";
  const c = await cursEur();

  const unde = [];
  const args = [];
  if (o.ofertaId) {
    unde.push("c.oferta_id = ?");
    args.push(o.ofertaId);
  } else if (o.achArticolId) {
    unde.push("c.ach_articol_id = ?");
    args.push(o.achArticolId);
  } else {
    return "";
  }

  const randuri = await db
    .prepare(
      `SELECT c.*, u.nume AS autor, p.nume AS partener
         FROM concurenta_preturi c
         LEFT JOIN utilizatori u ON u.id = c.creat_de
         LEFT JOIN parteneri p ON p.id = c.partener_id
        WHERE ${unde.join(" AND ")} AND c.activ = 1
        ORDER BY c.data_ofertei DESC, c.id DESC`
    )
    .all(...args);

  // De la CINE am aflat prețul. Pe o ofertare vine gata completat cu
  // partenerul ofertei, dar se poate schimba: de multe ori prețul
  // concurenței îl spune alt client decât cel pe care îl ofertezi acum, iar
  // peste șase luni singurul lucru care contează e de la cine ai auzit-o.
  const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();
  const optiuniPartener = (ales) =>
    parteneri.map((p) => `<option value="${p.id}"${Number(ales) === Number(p.id) ? " selected" : ""}>${esc(p.nume)}</option>`).join("");

  // prețurile noastre, indexate pe denumire normalizată și pe produs
  const refPeProdus = new Map();
  const refPeNume = new Map();
  for (const r of o.referinte || []) {
    const lei = inLei(r.pret, r.moneda, c);
    if (r.produs_id) refPeProdus.set(String(r.produs_id), lei);
    refPeNume.set(normalizeaza(r.denumire), lei);
  }
  const alNostru = (rand) => {
    if (rand.produs_id && refPeProdus.has(String(rand.produs_id))) return refPeProdus.get(String(rand.produs_id));
    const n = refPeNume.get(normalizeaza(rand.denumire));
    return n === undefined ? null : n;
  };

  const celulaDiferenta = (rand) => {
    const nostru = alNostru(rand);
    if (nostru === null || !(nostru > 0)) return '<span style="color:var(--text-muted)">—</span>';
    const lor = inLei(rand.pret, rand.moneda, c);
    const dif = ((lor - nostru) / nostru) * 100;
    // La VÂNZARE, concurentul mai ieftin ca noi e o problemă (roșu).
    // La ACHIZIȚIE, un preț mai mic decât al nostru înseamnă că altcineva ia
    // mai ieftin decât luăm noi — tot o problemă. În ambele cazuri, minusul
    // e semnalul, dar din motive diferite; de-aia textul explică, nu doar
    // culoarea.
    const rau = dif < 0;
    const semn = dif > 0 ? "+" : "";
    return `<span style="color:${rau ? "var(--danger)" : "var(--success)"}" title="al nostru ${money(nostru)} · al lor ${money(lor)}">${semn}${dif.toFixed(1)}%</span>`;
  };

  const actiune = directie === "achizitie" ? "/procurement/concurenta/adauga" : "/crm/concurenta/adauga";
  const optiuniProdus = (o.referinte || [])
    .map((r) => `<option value="${esc(r.denumire)}"${r.produs_id ? ` data-produs="${r.produs_id}"` : ""}>${esc(r.denumire)}</option>`)
    .join("");

  return `
    <h2>Prețurile concurenței${randuri.length ? ` (${randuri.length})` : ""}</h2>
    <p style="color:var(--text-muted);font-size:13px;margin:-4px 0 12px">
      ${
        directie === "achizitie"
          ? "Ce prețuri iau alții de la furnizorii ăștia. Scrie-le pe măsură ce le afli — peste șase luni, istoricul ăsta e singura ta măsură reală a pieței."
          : "Cu ce prețuri ne bate concurența la clientul ăsta. Scrie-le pe măsură ce le afli de la client — peste șase luni, istoricul ăsta e singura ta măsură reală a pieței."
      }
    </p>
    ${table(
      ["Produs", "Concurent", "Preț", "în lei", "Față de noi", "UM / cantitate", "Data ofertei", "Aflat de la", "Cum", "Adăugat de", ""],
      randuri.map((r) => [
        esc(r.denumire),
        `<strong>${esc(r.concurent)}</strong>`,
        `${Number(r.pret).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${esc(r.moneda)}`,
        money(inLei(r.pret, r.moneda, c)),
        celulaDiferenta(r),
        `${esc(r.um || "")}${r.cantitate ? ` · ${Number(r.cantitate).toLocaleString("ro-RO")}` : ""}`,
        esc(String(r.data_ofertei || "")),
        r.partener ? `<a href="/parteneri/${r.partener_id}">${esc(r.partener)}</a>` : '<span style="color:var(--text-muted)">—</span>',
        esc(ETICHETA_SURSA[r.sursa] || r.sursa || ""),
        esc(r.autor || ""),
        poateSterge(o.user, r)
          ? `<form method="post" action="/concurenta/${r.id}/sterge" class="inline-form"><input type="hidden" name="inapoi" value="${esc(o.inapoi || "")}"><button class="link-btn danger" type="submit">șterge</button></form>`
          : "",
      ])
    )}
    <form method="post" action="${actiune}" class="form" style="max-width:980px">
      <input type="hidden" name="directie" value="${esc(directie)}">
      ${o.ofertaId ? `<input type="hidden" name="oferta_id" value="${o.ofertaId}">` : ""}
      ${o.achArticolId ? `<input type="hidden" name="ach_articol_id" value="${o.achArticolId}">` : ""}
      <input type="hidden" name="inapoi" value="${esc(o.inapoi || "")}">
      <div class="rand" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <label style="flex:2 1 220px">Produs
          <input name="denumire" list="produse-concurenta-${directie}" required placeholder="ce produs a fost ofertat">
          <datalist id="produse-concurenta-${directie}">${optiuniProdus}</datalist>
        </label>
        <label style="flex:2 1 200px">Concurent
          <input name="concurent" required placeholder="cine a dat prețul">
        </label>
        <label style="flex:0 1 130px">Preț
          <input name="pret" type="number" step="0.0001" min="0" required>
        </label>
        <label style="flex:0 1 100px">Moneda
          <select name="moneda">${MONEDE.map((m) => `<option${m === (directie === "achizitie" ? "EUR" : "RON") ? " selected" : ""}>${m}</option>`).join("")}</select>
        </label>
        <label style="flex:0 1 90px">UM
          <input name="um" placeholder="kg, buc">
        </label>
        <label style="flex:0 1 120px">La cantitate
          <input name="cantitate" type="number" step="0.001" min="0" placeholder="opțional">
        </label>
        <label style="flex:0 1 150px">Data ofertei
          <input name="data_ofertei" type="date" value="${azi()}" required>
        </label>
        <label style="flex:2 1 220px">Aflat de la (client / furnizor)
          <select name="partener_id"><option value="">— nu știu / altcineva —</option>${optiuniPartener(o.partenerId)}</select>
        </label>
        <label style="flex:0 1 170px">Cum am aflat
          <select name="sursa">${SURSE.map(([v, e]) => `<option value="${v}"${v === (directie === "achizitie" ? "furnizor" : "client") ? " selected" : ""}>${esc(e)}</option>`).join("")}</select>
        </label>
        <label style="flex:3 1 260px">Observații
          <input name="observatii" placeholder="condiții, termen, ce a spus omul">
        </label>
        <button class="btn" type="submit">Adaugă prețul</button>
      </div>
    </form>
    <p style="font-size:12px;color:var(--text-muted)">„Față de noi" compară în lei, la cursul din <a href="/procurement">Procurement</a> (1 EUR = ${c.toLocaleString("ro-RO")} lei). Minusul e semnalul: la vânzare înseamnă că ei sunt mai ieftini la client, la achiziție că altcineva cumpără mai ieftin decât noi.</p>`;
}

// ---------------------------------------------------------------------------
// Scrierea. O singură funcție, trei porți de intrare (vânzări, procurement,
// rapoarte), fiindcă validarea trebuie să fie aceeași oriunde.
// ---------------------------------------------------------------------------
async function adauga(ctx, directieImplicita) {
  const b = ctx.body || {};
  const directie = String(b.directie || directieImplicita) === "achizitie" ? "achizitie" : "vanzare";
  const denumire = String(b.denumire || "").trim().slice(0, 300);
  const concurent = String(b.concurent || "").trim().slice(0, 200);
  const pret = Number(String(b.pret || "").replace(",", "."));
  const data = String(b.data_ofertei || "").slice(0, 10) || azi();
  const inapoi = String(b.inapoi || "") || (directie === "achizitie" ? "/procurement/concurenta" : "/crm/concurenta");

  // Fără produs, fără concurent sau fără preț pozitiv rândul n-ar spune nimic.
  // Nu arunc o eroare în față: trimit omul înapoi, formularul e tot acolo.
  if (!denumire || !concurent || !(pret > 0)) return redirect(ctx.res, inapoi);

  // Dacă denumirea se potrivește cu un produs din nomenclator, o leg — așa
  // raportul poate grupa pe produs, nu pe șiruri scrise de mână diferit.
  let produsId = Number(b.produs_id) || null;
  if (!produsId) {
    const p = await db.prepare("SELECT id FROM produse WHERE lower(denumire) = lower(?) ORDER BY id LIMIT 1").get(denumire);
    if (p) produsId = Number(p.id);
  }

  await db
    .prepare(
      `INSERT INTO concurenta_preturi
         (directie, produs_id, denumire, concurent, pret, moneda, um, cantitate, data_ofertei, sursa, oferta_id, ach_articol_id, partener_id, observatii, creat_de)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      directie,
      produsId,
      denumire,
      concurent,
      pret,
      String(b.moneda || "RON").toUpperCase().slice(0, 3),
      String(b.um || "").trim().slice(0, 20) || null,
      Number(String(b.cantitate || "").replace(",", ".")) || null,
      data,
      String(b.sursa || "").slice(0, 20) || null,
      Number(b.oferta_id) || null,
      Number(b.ach_articol_id) || null,
      Number(b.partener_id) || null,
      String(b.observatii || "").trim().slice(0, 500) || null,
      ctx.user ? ctx.user.id : null
    );
  return redirect(ctx.res, inapoi);
}

// ---------------------------------------------------------------------------
// Raportul. Unul singur, trei rute — fiecare cu ce are voie să vadă.
// ---------------------------------------------------------------------------
const VEDERI = { produse: "grupat pe produse", istoric: "istoric, rând cu rând" };

async function construiesteRaport(ctx, { directieFixa, titlu, subnav, activ }) {
  const q = ctx.query || {};
  const c = await cursEur();
  const directie = directieFixa || (q.directie === "achizitie" || q.directie === "vanzare" ? q.directie : "");
  const cauta = String(q.q || "").trim();
  const concurent = String(q.concurent || "").trim();
  const deLa = String(q.de_la || "").slice(0, 10);
  const panaLa = String(q.pana_la || "").slice(0, 10);
  const vedere = VEDERI[q.vedere] ? q.vedere : "produse";

  const unde = ["c.activ = 1"];
  const args = [];
  if (directie) {
    unde.push("c.directie = ?");
    args.push(directie);
  }
  if (cauta) {
    unde.push("(lower(c.denumire) LIKE lower(?) OR lower(c.concurent) LIKE lower(?) OR lower(COALESCE(c.observatii,'')) LIKE lower(?))");
    args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
  }
  if (concurent) {
    unde.push("lower(c.concurent) = lower(?)");
    args.push(concurent);
  }
  const partenerFiltru = Number(q.partener) || 0;
  if (partenerFiltru) {
    unde.push("c.partener_id = ?");
    args.push(partenerFiltru);
  }
  if (deLa) {
    unde.push("c.data_ofertei >= ?");
    args.push(deLa);
  }
  if (panaLa) {
    unde.push("c.data_ofertei <= ?");
    args.push(panaLa);
  }

  const randuri = await db
    .prepare(
      `SELECT c.*, u.nume AS autor, p.nume AS partener
         FROM concurenta_preturi c
         LEFT JOIN utilizatori u ON u.id = c.creat_de
         LEFT JOIN parteneri p ON p.id = c.partener_id
        WHERE ${unde.join(" AND ")}
        ORDER BY c.data_ofertei DESC, c.id DESC
        LIMIT 1000`
    )
    .all(...args);

  const concurenti = await db
    .prepare(
      `SELECT concurent, COUNT(*) AS n FROM concurenta_preturi WHERE activ = 1 ${directie ? "AND directie = ?" : ""}
        GROUP BY concurent ORDER BY n DESC, concurent ASC LIMIT 60`
    )
    .all(...(directie ? [directie] : []));

  // De la cine am aflat preturi — lista se face din ce s-a scris efectiv, nu
  // din toti partenerii, ca sa nu cauti un client de la care n-ai nimic.
  const surseParteneri = await db
    .prepare(
      `SELECT p.id, p.nume, COUNT(*) AS n
         FROM concurenta_preturi c JOIN parteneri p ON p.id = c.partener_id
        WHERE c.activ = 1 ${directie ? "AND c.directie = ?" : ""}
        GROUP BY p.id, p.nume ORDER BY n DESC, p.nume ASC LIMIT 60`
    )
    .all(...(directie ? [directie] : []));

  // Gruparea pe produs: ce mă interesează la un produs nu e lista, ci ultimul
  // preț al fiecărui concurent, cel mai mic și cel mai mare văzut vreodată, și
  // de când n-am mai aflat nimic. Un produs la care ultima informație e de
  // acum un an nu e „stabil", e nemonitorizat.
  const grupuri = new Map();
  for (const r of randuri) {
    const cheie = (r.directie || "") + "|" + (r.produs_id ? "p" + r.produs_id : "n" + normalizeaza(r.denumire));
    if (!grupuri.has(cheie))
      grupuri.set(cheie, { directie: r.directie, denumire: r.denumire, produsId: r.produs_id, randuri: [], concurenti: new Map(), surse: new Set() });
    const g = grupuri.get(cheie);
    g.randuri.push(r);
    if (r.partener) g.surse.add(r.partener);
    const lei = inLei(r.pret, r.moneda, c);
    const anterior = g.concurenti.get(r.concurent);
    // rândurile vin deja ordonate descrescător după dată, deci primul e ultimul preț
    if (!anterior) g.concurenti.set(r.concurent, { lei, data: r.data_ofertei });
  }

  const aziStr = azi();
  const zileDe = (d) => Math.round((Date.parse(aziStr + "T00:00:00Z") - Date.parse(String(d) + "T00:00:00Z")) / 86400000);

  const randuriGrup = [...grupuri.values()]
    .map((g) => {
      const preturi = g.randuri.map((r) => inLei(r.pret, r.moneda, c));
      const ultima = g.randuri[0];
      return {
        g,
        min: Math.min(...preturi),
        max: Math.max(...preturi),
        ultimPret: inLei(ultima.pret, ultima.moneda, c),
        ultimaData: ultima.data_ofertei,
        vechime: zileDe(ultima.data_ofertei),
      };
    })
    .sort((a, b) => a.vechime - b.vechime || String(a.g.denumire).localeCompare(String(b.g.denumire), "ro"));

  const badgeVechime = (z) =>
    z <= 30
      ? '<span class="badge verde">proaspăt</span>'
      : z <= 120
      ? '<span class="badge galben">' + z + " zile</span>"
      : '<span class="badge rosu">' + z + " zile</span>";

  const filtre = `
    <form class="filtre" method="get" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px">
      <label>Caută <input name="q" value="${esc(cauta)}" placeholder="produs, concurent, observații"></label>
      <label>Concurent
        <select name="concurent">
          <option value="">toți concurenții</option>
          ${concurenti.map((x) => `<option value="${esc(x.concurent)}"${x.concurent === concurent ? " selected" : ""}>${esc(x.concurent)} (${x.n})</option>`).join("")}
        </select>
      </label>
      <label>Aflat de la
        <select name="partener">
          <option value="">oricine</option>
          ${surseParteneri.map((x) => `<option value="${x.id}"${Number(partenerFiltru) === Number(x.id) ? " selected" : ""}>${esc(x.nume)} (${x.n})</option>`).join("")}
        </select>
      </label>
      <label>De la <input type="date" name="de_la" value="${esc(deLa)}"></label>
      <label>Până la <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
      ${directieFixa ? "" : `<label>Direcție <select name="directie"><option value="">achiziție și vânzare</option><option value="vanzare"${directie === "vanzare" ? " selected" : ""}>doar vânzare</option><option value="achizitie"${directie === "achizitie" ? " selected" : ""}>doar achiziție</option></select></label>`}
      <label>Vedere
        <select name="vedere">${Object.entries(VEDERI).map(([v, e]) => `<option value="${v}"${v === vedere ? " selected" : ""}>${esc(e)}</option>`).join("")}</select>
      </label>
      <button class="btn" type="submit">Filtrează</button>
      <a class="link-btn" href="?">Șterge filtrele</a>
    </form>`;

  const tabelProduse = table(
    ["Produs", directieFixa ? "" : "Direcție", "Concurenți (ultimul preț știut)", "Aflat de la", "Cel mai mic", "Cel mai mare", "Ultima informație", "Prețuri"].filter((x) => x !== ""),
    randuriGrup.map((x) =>
      [
        `<strong>${esc(x.g.denumire)}</strong>`,
        directieFixa ? null : x.g.directie === "achizitie" ? "achiziție" : "vânzare",
        [...x.g.concurenti.entries()]
          .sort((a, b) => a[1].lei - b[1].lei)
          .map(([nume, v]) => `${esc(nume)} <strong>${money(v.lei)}</strong> <span style="color:var(--text-muted);font-size:12px">(${v.data})</span>`)
          .join("<br>"),
        x.g.surse.size ? [...x.g.surse].map((n) => esc(n)).join("<br>") : '<span style="color:var(--text-muted)">—</span>',
        money(x.min),
        money(x.max),
        `${x.ultimaData} ${badgeVechime(x.vechime)}`,
        String(x.g.randuri.length),
      ].filter((v) => v !== null)
    )
  );

  const tabelIstoric = table(
    ["Data ofertei", directieFixa ? "" : "Direcție", "Produs", "Concurent", "Preț", "în lei", "UM / cantitate", "Aflat de la", "Cum", "Observații", "Adăugat de", ""].filter((x) => x !== ""),
    randuri.map((r) =>
      [
        esc(String(r.data_ofertei || "")),
        directieFixa ? null : r.directie === "achizitie" ? "achiziție" : "vânzare",
        esc(r.denumire),
        `<strong>${esc(r.concurent)}</strong>`,
        `${Number(r.pret).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${esc(r.moneda)}`,
        money(inLei(r.pret, r.moneda, c)),
        `${esc(r.um || "")}${r.cantitate ? ` · ${Number(r.cantitate).toLocaleString("ro-RO")}` : ""}`,
        r.partener ? `<a href="/parteneri/${r.partener_id}">${esc(r.partener)}</a>` : "",
        esc(ETICHETA_SURSA[r.sursa] || r.sursa || ""),
        `<span style="font-size:12px;color:var(--text-muted)">${esc(r.observatii || "")}</span>`,
        esc(r.autor || ""),
        poateSterge(ctx.user, r)
          ? `<form method="post" action="/concurenta/${r.id}/sterge" class="inline-form"><input type="hidden" name="inapoi" value="${esc(activ)}"><button class="link-btn danger" type="submit">șterge</button></form>`
          : "",
      ].filter((v) => v !== null)
    )
  );

  const totiParteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();
  const adaugaLiber = `
    <h2>Adaugă un preț aflat din piață</h2>
    <p style="color:var(--text-muted);font-size:13px;margin:-4px 0 12px">Pentru prețuri aflate în afara unei ofertări — la telefon, la târg, dintr-o listă primită pe email.</p>
    <form method="post" action="/concurenta/adauga" class="form" style="max-width:980px">
      <input type="hidden" name="inapoi" value="${esc(activ)}">
      <div class="rand" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        ${
          directieFixa
            ? `<input type="hidden" name="directie" value="${esc(directieFixa)}">`
            : `<label style="flex:0 1 150px">Direcție <select name="directie"><option value="vanzare">vânzare</option><option value="achizitie">achiziție</option></select></label>`
        }
        <label style="flex:2 1 220px">Produs <input name="denumire" required></label>
        <label style="flex:2 1 200px">Concurent <input name="concurent" required></label>
        <label style="flex:0 1 130px">Preț <input name="pret" type="number" step="0.0001" min="0" required></label>
        <label style="flex:0 1 100px">Moneda <select name="moneda">${MONEDE.map((m) => `<option>${m}</option>`).join("")}</select></label>
        <label style="flex:0 1 90px">UM <input name="um" placeholder="kg, buc"></label>
        <label style="flex:0 1 150px">Data ofertei <input name="data_ofertei" type="date" value="${aziStr}" required></label>
        <label style="flex:2 1 220px">Aflat de la <select name="partener_id"><option value="">— nu știu / altcineva —</option>${totiParteneri
          .map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`)
          .join("")}</select></label>
        <label style="flex:0 1 170px">Cum am aflat <select name="sursa">${SURSE.map(([v, e]) => `<option value="${v}">${esc(e)}</option>`).join("")}</select></label>
        <label style="flex:3 1 260px">Observații <input name="observatii"></label>
        <button class="btn" type="submit">Adaugă</button>
      </div>
    </form>`;

  const corp = `
    ${subnav || ""}
    <div class="cards">
      <div class="card"><div class="label">Prețuri în filtrul ales</div><div class="value">${randuri.length}</div></div>
      <div class="card"><div class="label">Produse urmărite</div><div class="value">${randuriGrup.length}</div></div>
      <div class="card"><div class="label">Concurenți</div><div class="value">${new Set(randuri.map((r) => r.concurent)).size}</div></div>
      <div class="card"><div class="label">Informații mai vechi de 4 luni</div><div class="value">${randuriGrup.filter((x) => x.vechime > 120).length}</div></div>
    </div>
    ${filtre}
    ${vedere === "produse" ? tabelProduse : tabelIstoric}
    <p style="font-size:12px;color:var(--text-muted)">Prețurile se aduc în lei la cursul din <a href="/procurement">Procurement</a> (1 EUR = ${c.toLocaleString("ro-RO")} lei) doar ca să fie comparabile — moneda originală rămâne scrisă alături. Lista se oprește la 1.000 de rânduri; îngustează perioada dacă o atingi.</p>
    ${adaugaLiber}`;

  return { corp, titlu, activ };
}

function register(router) {
  // --- adăugare, din oricare dintre cele trei zone -------------------------
  router.post("/crm/concurenta/adauga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    return adauga(ctx, "vanzare");
  });
  router.post("/procurement/concurenta/adauga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    return adauga(ctx, "achizitie");
  });
  router.post("/concurenta/adauga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    return adauga(ctx, "vanzare");
  });

  router.post("/concurenta/:id/sterge", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const id = Number(ctx.params.id);
    const rand = await db.prepare("SELECT id, creat_de, directie FROM concurenta_preturi WHERE id = ?").get(id);
    const inapoi = String((ctx.body || {}).inapoi || "") || (rand && rand.directie === "achizitie" ? "/procurement/concurenta" : "/crm/concurenta");
    // Nu se șterge de tot: se dezactivează. Un preț de piață greșit se scoate
    // din listă, dar nu se pierde — se poate afla că era corect.
    if (rand && poateSterge(ctx.user, rand)) await db.prepare("UPDATE concurenta_preturi SET activ = 0 WHERE id = ?").run(id);
    return redirect(ctx.res, inapoi);
  });

  // --- raportul, pe trei uși ----------------------------------------------
  router.get("/crm/concurenta", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const r = await construiesteRaport(ctx, {
      directieFixa: "vanzare",
      titlu: "Prețurile concurenței la clienți",
      subnav: subnavCrm ? subnavCrm("/crm/concurenta") : "",
      activ: "/crm/concurenta",
    });
    send(ctx.res, 200, layout({ user: ctx.user, title: r.titlu, active: "/crm", body: r.corp }));
  });

  router.get("/procurement/concurenta", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const r = await construiesteRaport(ctx, {
      directieFixa: "achizitie",
      titlu: "Prețurile concurenței la achiziții",
      subnav: `<div class="subnav"><a class="subnav-link" href="/procurement">Oferte de la furnizori</a><a class="subnav-link" href="/procurement/articole">Articole &amp; categorii</a><a class="subnav-link activ" href="/procurement/concurenta">Prețurile concurenței</a></div>`,
      activ: "/procurement/concurenta",
    });
    send(ctx.res, 200, layout({ user: ctx.user, title: r.titlu, active: "/procurement", body: r.corp }));
  });

  router.get("/rapoarte/concurenta", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const r = await construiesteRaport(ctx, {
      directieFixa: "",
      titlu: "Prețurile concurenței — istoric pe produse și date",
      subnav: "",
      activ: "/rapoarte/concurenta",
    });
    send(ctx.res, 200, layout({ user: ctx.user, title: r.titlu, active: "/rapoarte", body: r.corp }));
  });
}

module.exports = { register, blocBI, ultimelePeProdus, inLei, cursEur, normalizeaza, SURSE, MONEDE };
