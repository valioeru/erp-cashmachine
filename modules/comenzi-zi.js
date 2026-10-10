"use strict";
// Raport „Comenzi consumabile la zi" — comenzile zilnice ale clienților de
// curierat (azi: Sameday), cu venitul, costul și marja pe zi și pe produs.
//
// De unde vine: un Excel ținut în OneDrive, un rând pe zi lucrătoare, 15
// coloane de produs și un rând de prețuri sus. Aici e același model, cu două
// diferențe care contează:
//
//   1. PREȚUL E ÎNGHEȚAT PE LINIE. În Excel exista un singur rând de prețuri,
//      aplicat la tot. Când prețurile au crescut, pe 03.06.2026, rândurile
//      vechi au rămas valori fixe, iar cele noi au devenit formule — adică
//      jumătate de istoric înghețat și jumătate viu. A doua creștere ar fi
//      rescris retroactiv 2026 și ar fi lăsat 2025 pe loc. Aici fiecare linie
//      își ține prețul zilei ei, deci o schimbare de mâine nu atinge trecutul.
//
//   2. EXISTĂ ȘI COST, deci și marjă. Costul se completează de mână, pe
//      produs, și se îngheață pe linie la fel ca prețul. Unde costul lipsește,
//      marja NU se afișează ca zero — se afișează ca necunoscută, și raportul
//      spune cât din venit n-are cost în spate. Un zero fals e mai rău decât
//      un gol declarat.
//
// Istoricul (182 de zile, 04.11.2025 → 08.10.2026) se importă o singură dată,
// din date/sameday-istoric.json, la prima pornire în care tabelul e gol.
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const rapoarte = require("./rapoarte");
const cc = require("../lib/clienti-curierat");

const CLIENT = "Sameday";
const CALE = "/rapoarte/comenzi-la-zi";

const nr = (v) => Number(v || 0);

function azi() {
  return new Date().toISOString().slice(0, 10);
}

// Lunile se calculează pe șiruri, nu pe Date: un `new Date("2026-03-31")` plus
// o lună dă 1 mai, nu 30 aprilie, iar fusul orar mai mută o zi pe deasupra.
function lunaPlus(luna, pas) {
  let an = parseInt(String(luna).slice(0, 4), 10);
  let l = parseInt(String(luna).slice(5, 7), 10) + pas;
  while (l > 12) { l -= 12; an += 1; }
  while (l < 1) { l += 12; an -= 1; }
  return `${an}-${String(l).padStart(2, "0")}`;
}

function ultimaZiDinLuna(luna) {
  const an = parseInt(luna.slice(0, 4), 10);
  const l = parseInt(luna.slice(5, 7), 10);
  const z = new Date(Date.UTC(an, l, 0)).getUTCDate();
  return `${luna}-${String(z).padStart(2, "0")}`;
}

const LUNI = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
function etichetaLuna(luna) {
  const l = parseInt(String(luna).slice(5, 7), 10);
  return `${LUNI[l - 1] || luna} ${String(luna).slice(0, 4)}`;
}

function dataRo(iso) {
  const s = String(iso || "");
  return s.length >= 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
}

function procent(parte, intreg) {
  return nr(intreg) > 0 ? (nr(parte) / nr(intreg)) * 100 : 0;
}

// ---- recunoașterea produsului de pe AWB -------------------------------------
//
// Numele produsului scris pe eticheta AWB NU e numele din Excel. Două din
// cincisprezece diferă, iar diferența n-are nicio regulă:
//
//   Excel: „Bandă adezivă, acrilic, Fragil"      AWB: „Banda adeziva FRAGIL"
//   Excel: „Cutie mare, dimensiuni 460x410x373"  AWB: „Cutie mare SD1 (460 x 410 x 373)"
//
// Dacă recunoașterea merge doar pe nume identic, cele două produse ajung
// „nerecunoscute" în fiecare noapte, iar jobul refuză ziua. Dacă merge pe
// asemănare vagă, „Plic format A4" și „Top hârtie A4" se confundă — și atunci
// 15.100 de bucăți de plic se adună la hârtie. Niciuna din variante nu e bună.
//
// Deci recunoașterea are trei trepte, în ordinea încrederii, și se oprește la
// prima care dă EXACT un produs:
//
//   1. Nume identic, normalizat (fără diacritice, fără punctuație).
//   2. Un alias scris de mână pe produs (coloana `aliasuri`, un rând per
//      scriere alternativă). Aici intră cele două excepții de mai sus, și aici
//      intră orice nume nou pe care Sameday îl inventează — fără deploy.
//   3. Semnătura: FELUL produsului (plic / cutie / bandă / folie / top) plus
//      CODUL lui (sd1, d14, c5, a3, hv15, 460410373…). Felul e cel care
//      desparte „Plic format A4" de „Top hârtie A4" — fără el, codul „a4" ar
//      fi ambiguu. O semnătură care nimerește două produse nu leagă nimic.
//
// Ce nu se potrivește nu se ghicește: iese pe listă, cu numele exact de pe
// etichetă, și ziua nu se scrie. Un plic pierdut în tăcere costă mai mult
// decât o zi întârziată.

function cheieText(s) {
  let t = cc.reparaMojibake(String(s || ""));
  t = t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șşŞȘ]/g, "s")
    .replace(/[țţŢȚ]/g, "t")
    .toLowerCase();
  return t.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Felul produsului. „top" se caută primul: „Top hârtie A4" conține și „hartie",
// dar nu e plic și nu e cutie.
function felProdus(k) {
  if (/\btop\b/.test(k)) return "top";
  if (/\bplic/.test(k)) return "plic";
  if (/\bcuti/.test(k)) return "cutie";
  if (/\bband/.test(k)) return "banda";
  if (/\bfolie|stretch/.test(k)) return "folie";
  if (/\bhartie\b/.test(k)) return "top";
  return "";
}

// Codul produsului, în ordinea de la cel mai specific la cel mai general.
// „fragil" trece înaintea lui „acril" fiindcă banda Fragil E o bandă acrilică:
// pe nume complet apar amândouă, iar cea care o identifică e Fragil.
function codProdus(k) {
  const triplet = k.match(/\b(\d{2,4})\s*x?\s*(\d{2,4})\s*x\s*(\d{2,4})\b/);
  if (triplet) return triplet[1] + triplet[2] + triplet[3];
  const pereche = k.match(/\b(\d{3,4})\s*x\s*(\d{3,4})\b/);
  if (pereche) return pereche[1] + pereche[2];
  if (/\bfragil\b/.test(k)) return "fragil";
  const sd = k.match(/\bsd\s*([123])\b/);
  if (sd) return "sd" + sd[1];
  const litera = k.match(/\b([dgh])\s*(14|17|18)\b/);
  if (litera) return litera[1] + litera[2];
  if (/\bc\s*5\b/.test(k)) return "c5";
  if (/\bhv\s*15\b/.test(k)) return "hv15";
  if (/\bstandard\b.*\b23\b|\b23\b.*\bmicron/.test(k)) return "std23";
  if (/\bacril/.test(k)) return "acril";
  if (/\bsolvent\b/.test(k)) return "solvent";
  const a = k.match(/\ba\s*([34])\b/);
  if (a) return "a" + a[1];
  return "";
}

function semnatura(nume) {
  const k = cheieText(nume);
  const fel = felProdus(k);
  const cod = codProdus(k);
  return fel && cod ? fel + ":" + cod : "";
}

// Indexul se construiește o dată pe import, nu pe fiecare linie.
function indexeazaProduse(produse) {
  const dupaNume = new Map();
  const dupaSemnatura = new Map();
  const ambigue = new Set();
  const adaugaNume = (text, p) => {
    const k = cheieText(text);
    if (k && !dupaNume.has(k)) dupaNume.set(k, p);
  };
  for (const p of produse) {
    adaugaNume(p.denumire, p);
    for (const al of String(p.aliasuri || "").split(/[\r\n|]+/)) if (al.trim()) adaugaNume(al, p);
  }
  // Semnăturile se calculează DUPĂ nume, și numai din denumirea oficială plus
  // aliasuri: dacă două produse dau aceeași semnătură, semnătura aia nu mai
  // identifică nimic și se scoate din joc.
  for (const p of produse) {
    const texte = [p.denumire, ...String(p.aliasuri || "").split(/[\r\n|]+/)];
    for (const t of texte) {
      const s = semnatura(t);
      if (!s) continue;
      const vechi = dupaSemnatura.get(s);
      if (vechi && Number(vechi.id) !== Number(p.id)) ambigue.add(s);
      else dupaSemnatura.set(s, p);
    }
  }
  for (const s of ambigue) dupaSemnatura.delete(s);
  return { dupaNume, dupaSemnatura, ambigue };
}

function potrivesteProdus(nume, index) {
  const k = cheieText(nume);
  if (!k) return null;
  const exact = index.dupaNume.get(k);
  if (exact) return exact;
  const s = semnatura(nume);
  return (s && index.dupaSemnatura.get(s)) || null;
}

// ---- importul istoricului ---------------------------------------------------
//
// Rulează o singură dată: dacă există deja o zi în bază, nu mai face nimic.
// Nu suprascrie nimic și nu șterge nimic — dacă cineva a pus deja date de
// mână, importul se oprește și le lasă în pace.
async function seed() {
  let fisier;
  try {
    fisier = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sameday-istoric.json"), "utf8"));
  } catch (e) {
    return { produse: 0, zile: 0, motiv: "fără fișier de istoric" };
  }

  let produseNoi = 0;
  for (const p of fisier.produse || []) {
    const r = await db
      .prepare(
        `INSERT INTO consumabile_produse (cod, denumire, pret, ordine)
         VALUES (?,?,?,?) ON CONFLICT (cod) DO NOTHING`
      )
      .run(p.cod, p.denumire, nr(p.pret), nr(p.ordine));
    produseNoi += nr(r.changes);
  }

  // Cele două nume care diferă între Excel și etichetă. Se pun o singură dată,
  // numai dacă n-are deja aliasuri — ca să nu ștergem ce-a adăugat un om.
  // Verificate pe 419 etichete reale din 07–09.10.2026: cu ele, toate cele 14
  // scrieri de produs care apar pe etichete se recunosc; fără ele, două rămân
  // nerecunoscute și jobul de noapte refuză ziua, corect dar inutil.
  for (const [cod, alias] of [
    ["banda-fragil", "Banda adeziva FRAGIL"],
    ["cutie-mare", "Cutie mare SD1 (460 x 410 x 373)"],
  ]) {
    await db
      .prepare("UPDATE consumabile_produse SET aliasuri = ? WHERE cod = ? AND COALESCE(aliasuri, '') = ''")
      .run(alias, cod)
      .catch(() => null);
  }

  // Costurile se recalculează la FIECARE pornire, nu doar la primul import:
  // o scumpire la furnizor sau o rețetă schimbată trebuie să se vadă singură,
  // că asta a fost cerința — „nu vreau ceva manual, ci automat".
  const costuri = await recalculeazaCosturi().catch((e) => ({ produse: 0, eroare: e.message }));
  if (nr(costuri.produse)) {
    console.log(`[comenzi-zi] costuri din nomenclator: ${nr(costuri.cu_cost)} cu cost, ${nr(costuri.fara_cost)} fara`);
    await umpleCosturiLipsa().catch(() => null);
  }

  const cateZile = nr((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_zile WHERE client = ?").get(CLIENT)).n);
  if (cateZile > 0) return { produse: produseNoi, zile: 0, costuri, motiv: "istoricul era deja importat" };

  const produse = await db.prepare("SELECT id, cod, ordine FROM consumabile_produse ORDER BY ordine").all();
  const dupaCod = new Map(produse.map((p) => [p.cod, p.id]));
  const coduri = (fisier.produse || []).map((p) => p.cod);
  const preturi = fisier.preturi || [];

  let zileNoi = 0;
  for (const z of fisier.zile || []) {
    const ins = await db
      .prepare("INSERT INTO consumabile_zile (client, data, sursa) VALUES (?,?,?) RETURNING id")
      .run(CLIENT, z.d, "import Excel");
    const ziId = Number(ins.lastInsertRowid);
    const pret = preturi[z.p] || [];
    for (let i = 0; i < coduri.length; i++) {
      const cant = nr((z.q || [])[i]);
      if (!cant) continue;
      const produsId = dupaCod.get(coduri[i]);
      if (!produsId) continue;
      await db
        .prepare("INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret) VALUES (?,?,?,?)")
        .run(ziId, produsId, cant, nr(pret[i]));
    }
    zileNoi++;
  }
  await umpleCosturiLipsa().catch(() => null);
  console.log(`[comenzi-zi] istoric importat: ${zileNoi} zile, ${produseNoi} produse noi`);
  return { produse: produseNoi, zile: zileNoi, costuri };
}

// ---- costul, luat singur din nomenclator ------------------------------------
//
// Cerința lui Vali, 10.10.2026: „costurile ia-le din ERP per acel produs —
// intrări dacă e marfă și din cost producție dacă e produs de noi. Nu vreau
// ceva manual, ci automat."
//
// Deci costul vine în trei trepte, în ordinea asta:
//
//   1. COSTUL DIN REȚETĂ (`produse.cost_reteta`) — ce facem noi. E suma
//      componentelor pe o bucată, calculată de lib/cost.js la fiecare
//      schimbare de rețetă. Asta e „cost producție".
//   2. ULTIMA INTRARE DE MARFĂ — prețul unitar de pe cea mai recentă mișcare
//      de stoc de tip „intrare" cu preț. Asta e „intrări": o cifră de pe un
//      document real, nu un câmp scris cândva pe produs.
//   3. PREȚUL DE ACHIZIȚIE de pe produs — câmpul static. Nu știe de scumpiri,
//      dar e scris de om și e mai bun decât nimic.
//
// Ce NU folosim aici, deși e treapta 1 în lib/cost.js: `produse.cost_rata`,
// rata reală din contabilitate. Motivul e tehnic, nu de gust — rata e cost
// împărțit la vânzări, deci aplicată pe venit ea dă cost = venit × rată, iar
// marja iese identică la toate produsele, prin construcție. Pe un raport de
// cantități × preț unitar, asta nu e o măsurătoare, e o tautologie. Rata o
// arătăm separat, ca verificare, nu ca sursă.
//
// Dacă nicio treaptă nu dă un cost, costul rămâne NULL. Niciodată zero: un
// zero ar arăta marjă 100% și ar minți mai convingător decât un gol.
//
// PLASA DE SIGURANȚĂ: un cost de peste cinci ori prețul de vânzare nu e marjă
// proastă, e legătură greșită în nomenclator — o rolă de 1.720 lei pusă în
// locul unui plic de 26 de bani. Așa ceva cade la treapta următoare și, dacă
// nu mai e nicio treaptă, rămâne NULL și se vede pe pagină.
const COST_ABERANT = 5;

function costPlauzibil(cost, pret) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c <= 0) return false;
  const p = Number(pret) || 0;
  if (p <= 0) return true; // produs fără preț de vânzare — n-avem cu ce compara
  return c <= COST_ABERANT * p;
}

async function recalculeazaCosturi() {
  const produse = await db
    .prepare("SELECT id, cod, denumire, pret, produs_id, cost, cost_sursa FROM consumabile_produse WHERE produs_id IS NOT NULL")
    .all()
    .catch(() => []);
  if (!produse.length) return { produse: 0, cu_cost: 0, fara_cost: 0, motiv: "niciun produs legat la nomenclator" };

  const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
  let cuCost = 0;
  let faraCost = 0;
  const detalii = [];

  for (const p of produse) {
    const n = await db
      .prepare("SELECT id, denumire, pret_achizitie, cost_reteta, cost_reteta_lipsa, cost_rata FROM produse WHERE id = ?")
      .get(p.produs_id)
      .catch(() => null);

    let cost = null;
    let sursa = null;

    if (n && costPlauzibil(n.cost_reteta, p.pret)) {
      cost = Number(n.cost_reteta);
      sursa = "cost producție (rețeta produsului" + (nr(n.cost_reteta_lipsa) > 0 ? `, ${nr(n.cost_reteta_lipsa)} componente fără cost` : "") + ")";
    }

    if (cost == null && n) {
      const intrare = await db
        .prepare(
          `SELECT pret_unitar, data FROM miscari_stoc
            WHERE produs_id = ? AND tip = 'intrare' AND COALESCE(pret_unitar, 0) > 0
            ORDER BY data DESC, id DESC LIMIT 1`
        )
        .get(p.produs_id)
        .catch(() => null);
      if (intrare && costPlauzibil(intrare.pret_unitar, p.pret)) {
        cost = Number(intrare.pret_unitar);
        sursa = `intrare de marfă din ${dataRo(String(intrare.data || "").slice(0, 10))}`;
      }
    }

    if (cost == null && n && costPlauzibil(n.pret_achizitie, p.pret)) {
      cost = Number(n.pret_achizitie);
      sursa = "preț de achiziție de pe produs";
    }

    if (cost == null) {
      faraCost++;
      sursa = n ? "nomenclatorul n-are niciun cost plauzibil pentru produsul legat" : "produsul legat nu mai există";
    } else cuCost++;

    await db
      .prepare("UPDATE consumabile_produse SET cost = ?, cost_sursa = ?, nota_cost = ?, cost_la = ? WHERE id = ?")
      .run(cost, sursa, sursa, acum, p.id);
    detalii.push({ cod: p.cod, denumire: p.denumire, cost, sursa, rata: n ? n.cost_rata : null });
  }

  return { produse: produse.length, cu_cost: cuCost, fara_cost: faraCost, detalii };
}

// Zilele deja scrise au costul înghețat pe linie. După ce costurile vin din
// nomenclator, liniile care n-au avut cost trebuie să-l primească o dată —
// altfel 182 de zile de istoric rămân cu marja necunoscută pe veci.
//
// Se umplu DOAR liniile cu cost NULL. O linie care are deja un cost înghețat
// rămâne cum e: ăla era costul la data lui, iar scopul întregului modul e să nu
// rescrie trecutul.
async function umpleCosturiLipsa() {
  const r = await db
    .prepare(
      `UPDATE consumabile_linii l SET cost = p.cost
         FROM consumabile_produse p
        WHERE p.id = l.produs_id AND l.cost IS NULL AND p.cost IS NOT NULL`
    )
    .run()
    .catch(() => ({ changes: 0 }));
  const a = await db
    .prepare(
      `UPDATE consumabile_awb_linii l SET cost = p.cost
         FROM consumabile_produse p
        WHERE p.id = l.produs_id AND l.cost IS NULL AND p.cost IS NOT NULL`
    )
    .run()
    .catch(() => ({ changes: 0 }));
  return { linii: nr(r.changes), linii_awb: nr(a.changes) };
}

// ---- importul AWB-urilor ----------------------------------------------------
//
// Intrarea e lista de etichete a unei zile, așa cum ies din PDF-urile venite pe
// mail: { awb, data (de pe etichetă), kg, destinatar, adresa, oras, judet,
// agentie, articole: [{ cantitate, produs }] }.
//
// DATA DE RAPORT NU E DATA DE PE ETICHETĂ. Eticheta tipărită pe 09.10 duce
// comanda zilei de 08.10. Diferența s-a văzut comparând ziua parsată cu rândul
// din Excel: 08.10 nu dădea, 07.10 dădea exact. De-aia scăderea e explicită
// aici, nu ascunsă în parser, și de-aia ambele date se scriu în bază.
//
// REGULA DE REFUZ, convenită înainte de a scrie o linie: dacă MĂCAR UN articol
// nu se recunoaște, ziua nu se scrie. Nici parțial. Un import pe jumătate
// arată ca o zi slabă de vânzări, și nimeni nu se uită după ea.
function ziuaDeRaport(dataEtichetei) {
  const t = Date.parse(String(dataEtichetei).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return new Date(t - 86400000).toISOString().slice(0, 10);
}

// ULTIMELE TREI CIFRE ALE AWB-ULUI SUNT NUMĂRUL COLETULUI.
//
// Asta e capcana care ar fi umflat tot raportul. O comandă mare pleacă pe mai
// multe colete, fiecare colet are AWB-ul lui — și eticheta fiecăruia repetă
// comanda ÎNTREAGĂ, nu partea din el. NOVATECH PRO a primit într-o zi 60 de
// etichete cu „300 Top hârtie A4" pe fiecare. Comanda e 300 de topuri pe 60 de
// colete, nu 18.000 de topuri.
//
// Numărate pe etichetă, cele trei zile verificate dădeau 384.503 lei în loc de
// 22.417 — de șaptesprezece ori mai mult, și nimeni nu s-ar fi uitat a doua
// oară la un raport care arată bine. Deci se numără o dată pe EXPEDIȚIE:
// AWB-ul fără ultimele trei cifre.
//
// Verificat pe 419 etichete / 197 expediții din 07–09.10.2026: toate AWB-urile
// au 18 caractere, sufixele merg 001..N fără goluri, iar în niciun grup nu
// diferă nici articolele, nici destinatarul. Grupate așa, cele trei zile dau
// exact cifrele din Excel: 22.417,76 / 301,68 / 13.066,44.
//
// Kilogramele, în schimb, SE ADUNĂ: alea sunt pe colet, nu pe comandă.
const CIFRE_COLET = 3;

function cheieExpeditie(awb) {
  const s = String(awb || "").trim();
  return s.length > CIFRE_COLET ? s.slice(0, -CIFRE_COLET) : s;
}

function grupeazaColete(etichete) {
  const grupe = new Map();
  for (const e of etichete || []) {
    const k = cheieExpeditie(e.awb);
    if (!k) continue;
    const g = grupe.get(k);
    if (!g) {
      grupe.set(k, { ...e, awb: k, colete: 1, kg: nr(e.kg), colet_min: String(e.awb).slice(-CIFRE_COLET) });
      continue;
    }
    g.colete += 1;
    g.kg += nr(e.kg);
    // Datele descriptive se iau de pe primul colet care le are. La cele 197 de
    // expediții verificate n-a existat nicio nepotrivire, dar dacă apare una,
    // primul colet decide — nu ultimul, ca rezultatul să nu depindă de ordinea
    // în care au venit fișierele.
    for (const c of ["destinatar", "adresa", "oras", "judet", "agentie", "data"]) if (!g[c] && e[c]) g[c] = e[c];
    if (!g.articole || !g.articole.length) g.articole = e.articole;
  }
  return [...grupe.values()];
}

async function importaAwb(etichete, opt) {
  const o = opt || {};
  const uscat = !!o.uscat; // dry-run: calculează și raportează, nu scrie nimic
  const produse = await db.prepare("SELECT * FROM consumabile_produse WHERE activ = 1 ORDER BY ordine").all();
  const index = indexeazaProduse(produse);

  const peZiua = new Map();
  const necunoscute = new Map();
  let faraData = 0;

  // Întâi coletele se adună în expediții. Dacă nu se face asta ÎNAINTE de orice
  // altceva, o comandă pe 60 de colete intră de 60 de ori.
  const expeditii = grupeazaColete(etichete);

  for (const e of expeditii) {
    const zi = ziuaDeRaport(e.data);
    if (!zi || !e.awb) { faraData++; continue; }
    if (!peZiua.has(zi)) peZiua.set(zi, []);
    const articole = [];
    for (const a of e.articole || []) {
      const p = potrivesteProdus(a.produs, index);
      if (!p) {
        const k = cheieText(a.produs);
        necunoscute.set(k, { nume: String(a.produs), awb: e.awb, cantitate: nr(a.cantitate) });
        continue;
      }
      articole.push({ produs: p, cantitate: nr(a.cantitate) });
    }
    peZiua.get(zi).push({ ...e, zi, articole });
  }

  const raport = {
    zile: [...peZiua.keys()].sort(),
    etichete: (etichete || []).length,
    awb_uri: [...peZiua.values()].reduce((s, v) => s + v.length, 0),
    colete: [...peZiua.values()].reduce((s, v) => s + v.reduce((t, e) => t + nr(e.colete), 0), 0),
    necunoscute: [...necunoscute.values()],
    fara_data: faraData,
    scris: false,
    detaliu: [],
  };

  if (raport.necunoscute.length) {
    raport.motiv = `${raport.necunoscute.length} articole nerecunoscute — ziua nu se scrie până nu primesc un alias`;
    return raport;
  }
  if (uscat) {
    raport.motiv = "probă uscată — n-am scris nimic";
    for (const [zi, lista] of peZiua) raport.detaliu.push(await previzualizeazaZi(zi, lista, produse));
    return raport;
  }

  for (const [zi, lista] of peZiua) raport.detaliu.push(await scrieZiDinAwb(zi, lista, o));
  raport.scris = true;
  return raport;
}

// Totalul zilei, calculat din AWB-uri, fără să atingă baza.
async function previzualizeazaZi(zi, lista, produse) {
  const sume = new Map();
  for (const e of lista) for (const a of e.articole) sume.set(a.produs.id, (sume.get(a.produs.id) || 0) + a.cantitate);
  const dupaId = new Map(produse.map((p) => [Number(p.id), p]));
  let venit = 0;
  const linii = [];
  for (const [pid, cant] of sume) {
    const p = dupaId.get(Number(pid));
    const v = cant * nr(p && p.pret);
    venit += v;
    linii.push({ cod: p && p.cod, denumire: p && p.denumire, cantitate: cant, pret: nr(p && p.pret), valoare: v });
  }
  const existenta = await db.prepare("SELECT id, sursa FROM consumabile_zile WHERE client = ? AND data = ?").get(CLIENT, zi).catch(() => null);
  return {
    zi,
    awb_uri: lista.length,
    colete: lista.reduce((s2, e) => s2 + nr(e.colete), 0),
    venit,
    linii: linii.sort((a, b) => b.valoare - a.valoare),
    exista_deja: !!existenta,
    sursa_existenta: existenta ? existenta.sursa : null,
  };
}

async function scrieZiDinAwb(zi, lista, o) {
  const produse = await db.prepare("SELECT * FROM consumabile_produse WHERE activ = 1").all();
  const dupaId = new Map(produse.map((p) => [Number(p.id), p]));

  let ziRand = await db.prepare("SELECT id, sursa FROM consumabile_zile WHERE client = ? AND data = ?").get(CLIENT, zi);
  if (!ziRand) {
    const ins = await db
      .prepare("INSERT INTO consumabile_zile (client, data, sursa, creat_de) VALUES (?,?,?,?) RETURNING id")
      .run(CLIENT, zi, "AWB", o.userId || null);
    ziRand = { id: Number(ins.lastInsertRowid), sursa: "AWB" };
  }
  const ziId = Number(ziRand.id);

  // Clienții. Adresa, orașul și agenția se completează dacă lipsesc, dar nu se
  // rescriu: un client care s-a mutat o dată n-are nevoie să fie rescris de
  // fiecare AWB, iar prima adresă cunoscută e la fel de bună ca a zecea.
  const clientiAwb = new Map();
  for (const e of lista) {
    const nume = cc.curataNume(e.destinatar);
    const cheie = cc.cheieClient(nume);
    if (!cheie) continue;
    if (!clientiAwb.has(cheie)) clientiAwb.set(cheie, { nume, cheie, trunchiat: cc.esteTrunchiat(e.destinatar) ? 1 : 0, oras: e.oras || null, judet: e.judet || null, adresa: e.adresa || null, agentie: e.agentie || null });
  }
  const idClient = new Map();
  for (const [cheie, c] of clientiAwb) {
    let r = await db.prepare("SELECT id FROM consumabile_clienti WHERE cheie = ?").get(cheie);
    if (!r) {
      const ins = await db
        .prepare(
          `INSERT INTO consumabile_clienti (nume, cheie, oras, judet, adresa, agentie, prima_comanda, ultima_comanda, trunchiat)
           VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`
        )
        .run(c.nume, cheie, c.oras, c.judet, c.adresa, c.agentie, zi, zi, c.trunchiat);
      r = { id: Number(ins.lastInsertRowid) };
    } else {
      await db
        .prepare(
          `UPDATE consumabile_clienti
              SET oras = COALESCE(oras, ?), judet = COALESCE(judet, ?), adresa = COALESCE(adresa, ?),
                  agentie = COALESCE(agentie, ?),
                  prima_comanda = LEAST(COALESCE(prima_comanda, ?), ?),
                  ultima_comanda = GREATEST(COALESCE(ultima_comanda, ?), ?),
                  nume = CASE WHEN trunchiat = 1 AND ? = 0 THEN ? ELSE nume END,
                  trunchiat = CASE WHEN ? = 0 THEN 0 ELSE trunchiat END
            WHERE id = ?`
        )
        .run(c.oras, c.judet, c.adresa, c.agentie, zi, zi, zi, zi, c.trunchiat, c.nume, c.trunchiat, r.id);
    }
    idClient.set(cheie, Number(r.id));
  }

  // AWB-urile și liniile lor.
  let awbNoi = 0;
  for (const e of lista) {
    const cheie = cc.cheieClient(cc.curataNume(e.destinatar));
    const ins = await db
      .prepare(
        `INSERT INTO consumabile_awb (awb, zi_id, client_id, data_awb, kg, colete, agentie, fisier)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (awb) DO UPDATE SET zi_id = EXCLUDED.zi_id, client_id = EXCLUDED.client_id,
               data_awb = EXCLUDED.data_awb, agentie = EXCLUDED.agentie,
               -- Coletele si kilogramele pot veni in mai multe mailuri. GREATEST,
               -- nu adunare: un reimport al aceluiasi mail n-are voie sa dubleze,
               -- dar un colet venit mai tarziu trebuie sa urce numarul.
               kg = GREATEST(COALESCE(consumabile_awb.kg, 0), EXCLUDED.kg),
               colete = GREATEST(consumabile_awb.colete, EXCLUDED.colete)
         RETURNING id`
      )
      .run(String(e.awb), ziId, idClient.get(cheie) || null, String(e.data).slice(0, 10), nr(e.kg) || null, nr(e.colete) || 1, e.agentie || null, e.fisier || null);
    const awbId = Number(ins.lastInsertRowid);
    awbNoi++;
    for (const a of e.articole) {
      const p = dupaId.get(Number(a.produs.id)) || a.produs;
      await db
        .prepare(
          `INSERT INTO consumabile_awb_linii (awb_id, produs_id, cantitate, pret, cost)
           VALUES (?,?,?,?,?)
           ON CONFLICT (awb_id, produs_id) DO UPDATE SET cantitate = EXCLUDED.cantitate`
        )
        .run(awbId, p.id, a.cantitate, nr(p.pret), p.cost == null ? null : nr(p.cost));
    }
  }

  // Totalul zilei, recalculat din AWB-uri. Aici se rescrie `consumabile_linii`
  // pentru ziua asta: e cifra care trebuie să dea egal cu factura, iar sursa ei
  // de adevăr sunt AWB-urile, nu ce-a fost scris înainte.
  const sume = await db
    .prepare(
      `SELECT l.produs_id, SUM(l.cantitate) AS cantitate
         FROM consumabile_awb_linii l JOIN consumabile_awb a ON a.id = l.awb_id
        WHERE a.zi_id = ? GROUP BY l.produs_id`
    )
    .all(ziId);
  const ids = sume.map((s) => Number(s.produs_id));
  for (const s of sume) {
    const p = dupaId.get(Number(s.produs_id));
    await db
      .prepare(
        `INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret, cost)
         VALUES (?,?,?,?,?)
         ON CONFLICT (zi_id, produs_id) DO UPDATE SET cantitate = EXCLUDED.cantitate`
      )
      .run(ziId, s.produs_id, nr(s.cantitate), nr(p && p.pret), p && p.cost != null ? nr(p.cost) : null);
  }
  // Un produs care nu mai apare pe AWB-urile zilei nu mai are ce căuta în total.
  if (ids.length) {
    await db
      .prepare(`DELETE FROM consumabile_linii WHERE zi_id = ? AND produs_id NOT IN (${ids.map(() => "?").join(",")})`)
      .run(ziId, ...ids);
  }
  await db.prepare("UPDATE consumabile_zile SET sursa = 'AWB' WHERE id = ?").run(ziId);

  const t = await totalPerioada(zi, zi);
  return {
    zi,
    awb_uri: awbNoi,
    colete: lista.reduce((s2, e) => s2 + nr(e.colete), 0),
    clienti: idClient.size,
    produse: sume.length,
    venit: nr(t.venit),
  };
}

// ---- interogările raportului ------------------------------------------------

async function peProdus(deLa, panaLa) {
  return db
    .prepare(
      `SELECT p.id, p.cod, p.denumire, p.um, p.ordine, p.cost AS cost_curent,
              SUM(l.cantitate) AS cantitate,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost
         FROM consumabile_linii l
         JOIN consumabile_zile z ON z.id = l.zi_id
         JOIN consumabile_produse p ON p.id = l.produs_id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?
        GROUP BY p.id, p.cod, p.denumire, p.um, p.ordine, p.cost
        ORDER BY p.ordine`
    )
    .all(CLIENT, deLa, panaLa);
}

async function peZi(deLa, panaLa) {
  return db
    .prepare(
      `SELECT z.data, z.sursa,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost,
              COUNT(*) AS linii
         FROM consumabile_zile z
         JOIN consumabile_linii l ON l.zi_id = z.id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?
        GROUP BY z.data, z.sursa
        ORDER BY z.data DESC`
    )
    .all(CLIENT, deLa, panaLa);
}

async function totalPerioada(deLa, panaLa) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(l.cantitate * l.pret), 0) AS venit,
              COALESCE(SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END), 0) AS cost,
              COALESCE(SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END), 0) AS venit_fara_cost,
              COUNT(DISTINCT z.data) AS zile
         FROM consumabile_zile z
         JOIN consumabile_linii l ON l.zi_id = z.id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?`
    )
    .get(CLIENT, deLa, panaLa);
  return r || { venit: 0, cost: 0, venit_fara_cost: 0, zile: 0 };
}

// ---- clienții de pe AWB -----------------------------------------------------
//
// Toate interogările de aici merg pe `consumabile_awb_linii`, nu pe totalul
// zilei: numai AWB-ul știe CINE a comandat. Dacă o zi a intrat de mână, fără
// AWB-uri, ea apare în totalul lunii dar nu în topul clienților — și pagina
// spune cât venit e în situația asta, ca nimeni să nu creadă că topul acoperă
// tot.

async function topClienti(deLa, panaLa, limita) {
  return db
    .prepare(
      `SELECT c.id, c.nume, c.oras, c.judet, c.agentie, c.trunchiat,
              COUNT(DISTINCT a.id) AS awb_uri,
              -- Coletele vin din subinterogare: pe join s-ar inmulti cu numarul
              -- de produse de pe expeditie.
              COALESCE((SELECT SUM(a3.colete) FROM consumabile_awb a3
                          JOIN consumabile_zile z3 ON z3.id = a3.zi_id
                         WHERE a3.client_id = c.id AND z3.data >= ? AND z3.data <= ?), 0) AS colete,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost,
              SUM(l.cantitate) AS bucati,
              MAX(a.data_awb) AS ultimul_awb,
              -- Kilogramele NU se pot aduna din join: un AWB cu trei produse ar
              -- intra de trei ori. Se iau din subinterogare, pe AWB-uri.
              COALESCE((SELECT SUM(a2.kg) FROM consumabile_awb a2
                          JOIN consumabile_zile z2 ON z2.id = a2.zi_id
                         WHERE a2.client_id = c.id AND z2.data >= ? AND z2.data <= ?), 0) AS kg
         FROM consumabile_awb_linii l
         JOIN consumabile_awb a ON a.id = l.awb_id
         JOIN consumabile_zile z ON z.id = a.zi_id
         JOIN consumabile_clienti c ON c.id = a.client_id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?
        GROUP BY c.id, c.nume, c.oras, c.judet, c.agentie, c.trunchiat
        ORDER BY venit DESC
        LIMIT ${Number(limita) > 0 ? Number(limita) : 20}`
    )
    // Ordinea argumentelor urmează ordinea textuală a semnelor „?": mai întâi
    // subinterogarea de colete, apoi cea de kilograme, apoi clauza WHERE.
    .all(deLa, panaLa, deLa, panaLa, CLIENT, deLa, panaLa)
    .catch(() => []);
}

// Cât din venitul perioadei are AWB în spate — adică pe cât din el putem spune
// cine a comandat.
async function acoperireAwb(deLa, panaLa) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(l.cantitate * l.pret), 0) AS venit_awb,
              COUNT(DISTINCT a.id) AS awb_uri,
              COUNT(DISTINCT a.client_id) AS clienti
         FROM consumabile_awb_linii l
         JOIN consumabile_awb a ON a.id = l.awb_id
         JOIN consumabile_zile z ON z.id = a.zi_id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?`
    )
    .get(CLIENT, deLa, panaLa)
    .catch(() => null);
  return r || { venit_awb: 0, awb_uri: 0, clienti: 0 };
}

async function produsePerClient(clientId, deLa, panaLa) {
  return db
    .prepare(
      `SELECT p.cod, p.denumire, p.um,
              SUM(l.cantitate) AS cantitate,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost
         FROM consumabile_awb_linii l
         JOIN consumabile_awb a ON a.id = l.awb_id
         JOIN consumabile_zile z ON z.id = a.zi_id
         JOIN consumabile_produse p ON p.id = l.produs_id
        WHERE a.client_id = ? AND z.data >= ? AND z.data <= ?
        GROUP BY p.cod, p.denumire, p.um, p.ordine
        ORDER BY venit DESC`
    )
    .all(clientId, deLa, panaLa)
    .catch(() => []);
}

// Topul produselor pe fiecare client din top — într-o singură interogare, nu
// una pe client. Cu douăzeci de clienți pe pagină, douăzeci de interogări
// separate se simt.
async function produseTopClienti(ids, deLa, panaLa, cateFiecare) {
  if (!ids || !ids.length) return new Map();
  const semne = ids.map(() => "?").join(",");
  const randuri = await db
    .prepare(
      `SELECT a.client_id, p.denumire, p.um,
              SUM(l.cantitate) AS cantitate,
              SUM(l.cantitate * l.pret) AS venit
         FROM consumabile_awb_linii l
         JOIN consumabile_awb a ON a.id = l.awb_id
         JOIN consumabile_zile z ON z.id = a.zi_id
         JOIN consumabile_produse p ON p.id = l.produs_id
        WHERE a.client_id IN (${semne}) AND z.data >= ? AND z.data <= ?
        GROUP BY a.client_id, p.denumire, p.um
        ORDER BY a.client_id, venit DESC`
    )
    .all(...ids, deLa, panaLa)
    .catch(() => []);
  const peClient = new Map();
  for (const r of randuri) {
    const k = Number(r.client_id);
    if (!peClient.has(k)) peClient.set(k, []);
    const lista = peClient.get(k);
    if (lista.length < (Number(cateFiecare) || 3)) lista.push(r);
  }
  return peClient;
}

async function clientulCu(id) {
  return db.prepare("SELECT * FROM consumabile_clienti WHERE id = ?").get(id).catch(() => null);
}

async function awbClient(clientId, limita) {
  return db
    .prepare(
      `SELECT a.awb, a.data_awb, a.kg, a.colete, a.agentie, z.data AS zi,
              COALESCE(SUM(l.cantitate * l.pret), 0) AS venit,
              COUNT(l.id) AS produse
         FROM consumabile_awb a
         JOIN consumabile_zile z ON z.id = a.zi_id
         LEFT JOIN consumabile_awb_linii l ON l.awb_id = a.id
        WHERE a.client_id = ?
        GROUP BY a.awb, a.data_awb, a.kg, a.colete, a.agentie, z.data
        ORDER BY a.data_awb DESC, a.awb
        LIMIT ${Number(limita) > 0 ? Number(limita) : 60}`
    )
    .all(clientId)
    .catch(() => []);
}

// ---- bucăți de pagină -------------------------------------------------------

function cardulLunii(titlu, t) {
  const venit = nr(t.venit);
  const cuCost = venit - nr(t.venit_fara_cost);
  const marja = cuCost - nr(t.cost);
  const pct = procent(marja, cuCost);
  return `<div class="card">
    <div class="label">${esc(titlu)}</div>
    <div class="value">${money(venit)}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
      ${cuCost > 0 ? `marjă ${money(marja)} · ${pct.toFixed(1)}%` : "marjă necunoscută (fără cost)"}
      ${nr(t.zile) ? ` · ${nr(t.zile)} zile` : ""}
    </div>
  </div>`;
}

function tabelProduse(produse, totalMarja) {
  if (!produse.length) return '<p style="color:var(--text-muted)">Nicio comandă în perioada aleasă.</p>';
  const randuri = produse.map((p) => {
    const venit = nr(p.venit);
    const cuCost = venit - nr(p.venit_fara_cost);
    const marja = cuCost - nr(p.cost);
    const areCost = cuCost > 0;
    const sub = areCost && marja < 0;
    return [
      esc(p.denumire) + (sub ? ' <span class="badge rosu">sub cost</span>' : ""),
      nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "buc"),
      money(venit),
      areCost ? money(p.cost) : "—",
      areCost ? money(marja) : "—",
      areCost ? procent(marja, cuCost).toFixed(1) + "%" : "—",
      areCost && totalMarja > 0 ? procent(marja, totalMarja).toFixed(1) + "%" : "—",
    ];
  });
  return table(
    ["Produs", "Cantitate", "Venit", "Cost", "Marjă", "Marjă %", "Din marja perioadei"],
    randuri
  );
}

function tabelZile(zile) {
  if (!zile.length) return "";
  return table(
    ["Ziua", "Venit", "Cost", "Marjă", "Marjă %", "Produse", "Sursa"],
    zile.map((z) => {
      const venit = nr(z.venit);
      const cuCost = venit - nr(z.venit_fara_cost);
      const marja = cuCost - nr(z.cost);
      return [
        `<strong>${dataRo(z.data)}</strong>`,
        money(venit),
        cuCost > 0 ? money(z.cost) : "—",
        cuCost > 0 ? money(marja) : "—",
        cuCost > 0 ? procent(marja, cuCost).toFixed(1) + "%" : "—",
        nr(z.linii),
        esc(z.sursa || ""),
      ];
    })
  );
}

function formularZi(produse, zi, cantitati) {
  const campuri = produse
    .map(
      (p) => `<label style="flex:1 1 170px;min-width:150px">
        <span style="display:block;font-size:12px;color:var(--text-muted);line-height:1.25;min-height:30px">${esc(p.denumire)}</span>
        <input name="c_${p.id}" type="number" step="any" min="0" value="${cantitati[p.id] != null ? cantitati[p.id] : ""}" placeholder="0">
      </label>`
    )
    .join("");
  return `<form method="post" action="${CALE}/zi" class="form">
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">
      <label style="flex:0 1 190px">Ziua <input name="data" type="date" value="${esc(zi)}" required></label>
      <button class="btn" type="submit">Salvează ziua</button>
      <span style="font-size:12px;color:var(--text-muted)">Prețul se ia din lista de mai jos și rămâne înghețat pe liniile zilei.</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${campuri}</div>
  </form>`;
}

function formularCosturi(produse) {
  const randuri = produse.map((p) => {
    const legat = !!p.produs_id;
    return [
      esc(p.denumire),
      `<input name="p_${p.id}" type="number" step="0.0001" min="0" value="${nr(p.pret) || ""}" style="width:110px">`,
      legat
        ? `<span title="${esc(p.cost_sursa || "")}">${p.cost == null ? "—" : money(p.cost)}</span>`
        : `<input name="k_${p.id}" type="number" step="0.0001" min="0" value="${p.cost == null ? "" : nr(p.cost)}" style="width:110px" placeholder="necunoscut">`,
      legat
        ? `<span style="font-size:12px;color:var(--text-muted)">${esc(p.cost_sursa || "nomenclator")}</span>`
        : `<input name="n_${p.id}" value="${esc(p.nota_cost || "")}" placeholder="de unde vine costul" style="width:100%">`,
      `<input name="a_${p.id}" value="${esc(p.aliasuri || "")}" placeholder="alt nume de pe etichetă" style="width:100%">`,
    ];
  });
  return `<form method="post" action="${CALE}/costuri" class="form">
    ${table(["Produs", "Preț vânzare (lei)", "Cost (lei)", "De unde vine costul", "Alias pe eticheta AWB"], randuri)}
    <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">
      Costul produselor legate la nomenclator nu se mai scrie de mână — se ia singur, din rețetă sau din
      ultima intrare de marfă. Caseta de cost rămâne editabilă numai la produsele nelegate.
    </p>
    <button class="btn" type="submit" style="margin-top:10px">Salvează prețurile, costurile manuale și aliasurile</button>
  </form>`;
}

// ---- legarea la nomenclator -------------------------------------------------
//
// Costul vine automat, dar LEGĂTURA se face o dată, cu ochii. Motivul se vede
// în nomenclator: pentru plicul AWB C5 există „Plicuri autoadezive AWB C5",
// „Plicuri autoadezive AWB C5 CM" și „PLIC AWB C5 235X175", iar pentru banda
// transparentă există și „SOLVENT MARO" și „SOLVENT TR". O potrivire pe
// asemănare de nume ar alege una la întâmplare, iar costul greșit nu dă eroare
// — dă o marjă liniștită și falsă. Deci: sugestii ordonate, alegerea omului,
// apoi costul curge singur la fiecare recalcul.

function scorPotrivire(cheieConsumabil, cheieNomenclator) {
  const a = cheieConsumabil.split(" ").filter((t) => t.length > 1);
  const b = new Set(cheieNomenclator.split(" ").filter((t) => t.length > 1));
  if (!a.length || !b.size) return 0;
  let comune = 0;
  for (const t of a) if (b.has(t)) comune++;
  // Jaccard, ca un nume stufos din nomenclator („PLICURI AUTOADEZIVE AWB C5 CM
  // 235X175 ALB") să nu bată unul exact doar fiindcă are mai multe cuvinte.
  const uniune = new Set([...a, ...b]).size;
  let s = comune / uniune;
  // Codul distinctiv valorează mai mult decât un cuvânt oarecare.
  const cod = codProdus(cheieConsumabil);
  if (cod && cheieNomenclator.replace(/\s+/g, "").includes(cod)) s += 0.35;
  const fel = felProdus(cheieConsumabil);
  if (fel && felProdus(cheieNomenclator) === fel) s += 0.15;
  return s;
}

async function sugestiiLegare(consumabile) {
  const nomenclator = await db
    .prepare(
      `SELECT id, cod, denumire, unitate_masura, pret_achizitie, cost_reteta, cost_rata
         FROM produse WHERE COALESCE(activ, 1) = 1 AND fuzionat_in IS NULL ORDER BY denumire`
    )
    .all()
    .catch(() => []);
  const pregatit = nomenclator.map((p) => ({ ...p, k: cheieText(p.denumire) }));
  const sugestii = new Map();
  for (const c of consumabile) {
    const k = cheieText(c.denumire);
    sugestii.set(
      Number(c.id),
      pregatit
        .map((p) => ({ p, s: scorPotrivire(k, p.k) }))
        .filter((x) => x.s > 0.12)
        .sort((x, y) => y.s - x.s)
        .slice(0, 8)
    );
  }
  return { nomenclator, sugestii };
}

function formularLegare(consumabile, date) {
  const randuri = consumabile.map((c) => {
    const sug = date.sugestii.get(Number(c.id)) || [];
    const legatNesugerat =
      c.produs_id && !sug.some((x) => Number(x.p.id) === Number(c.produs_id))
        ? `<option value="${c.produs_id}" selected>produsul legat acum (#${c.produs_id})</option>`
        : "";
    const opt = sug
      .map(
        (x) =>
          `<option value="${x.p.id}"${Number(c.produs_id) === Number(x.p.id) ? " selected" : ""}>${esc(x.p.denumire)}${
            x.p.cod ? ` [${esc(x.p.cod)}]` : ""
          } — ${
            nr(x.p.cost_reteta) > 0
              ? "rețetă " + money(x.p.cost_reteta)
              : nr(x.p.pret_achizitie) > 0
                ? "achiziție " + money(x.p.pret_achizitie)
                : "fără cost"
          }</option>`
      )
      .join("");
    return [
      esc(c.denumire),
      money(c.pret),
      `<select name="l_${c.id}" style="max-width:420px"><option value="">— nelegat —</option>${legatNesugerat}${opt}</select>`,
      // Un cost mai mare decât prețul de vânzare trece de plasa de 5× dar e
      // aproape sigur o legătură greșită: plicul AWB C5 se vinde la 9 bani, iar
      // un cost de 19 bani ar da marjă negativă fără să pară o eroare. Se vede.
      c.cost == null
        ? '<span style="color:var(--text-muted)">—</span>'
        : money(c.cost) + (nr(c.cost) > nr(c.pret) ? ' <span class="badge rosu">peste preț</span>' : ""),
      `<span style="font-size:12px;color:var(--text-muted)">${esc(c.cost_sursa || "")}</span>`,
    ];
  });
  return `<form method="post" action="${CALE}/legare" class="form">
    ${table(["Produs din comandă", "Preț vânzare", "Produsul din nomenclator", "Cost rezultat", "Temei"], randuri)}
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <button class="btn" type="submit">Leagă și recalculează costurile</button>
      <label style="font-size:13px;display:flex;gap:6px;align-items:center">
        <input type="checkbox" name="umple" value="1" checked> umple și zilele vechi care n-au cost
      </label>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:8px">
      Lista arată doar produsele care seamănă la nume. Dacă cel potrivit nu e între ele, caută-l în
      <a href="/produse/fuziune">nomenclator</a> — de multe ori există sub două-trei coduri și merită
      unificat înainte de legare.
    </p>
  </form>`;
}

// ---- clienții în pagină -----------------------------------------------------

function tabelTopClienti(clienti, produse, venitPerioada) {
  if (!clienti.length)
    return `<p style="color:var(--text-muted)">Nicio zi cu AWB-uri în perioada asta. Topul clienților se face din etichetele AWB — zilele introduse de mână intră în totaluri, dar nu spun cine a comandat.</p>`;
  const randuri = clienti.map((c) => {
    const venit = nr(c.venit);
    const cuCost = venit - nr(c.venit_fara_cost);
    const marja = cuCost - nr(c.cost);
    const top = (produse.get(Number(c.id)) || [])
      .map((p) => `${esc(p.denumire)} <span style="color:var(--text-muted)">${nr(p.cantitate).toLocaleString("ro-RO")} ${esc(p.um || "buc")}</span>`)
      .join("<br>");
    return [
      `<a href="${CALE}/client/${c.id}">${esc(c.nume)}</a>${
        nr(c.trunchiat) ? ' <span class="badge galben" title="numele e tăiat de lățimea etichetei AWB">nume tăiat</span>' : ""
      }`,
      esc([c.oras, c.judet].filter(Boolean).join(", ") || "—"),
      nr(c.awb_uri).toLocaleString("ro-RO"),
      nr(c.colete).toLocaleString("ro-RO"),
      nr(c.kg) ? nr(c.kg).toLocaleString("ro-RO", { maximumFractionDigits: 1 }) + " kg" : "—",
      money(venit),
      venitPerioada > 0 ? procent(venit, venitPerioada).toFixed(1) + "%" : "—",
      cuCost > 0 ? money(marja) : "—",
      top || "—",
    ];
  });
  return table(["Client (al Sameday)", "Oraș", "Expediții", "Colete", "Greutate", "Venit", "Din perioadă", "Marjă", "Ce cumpără"], randuri);
}

// Avertismentul care stă deasupra topului. Nu e decor: lista de mai jos arată
// exact ca o listă de prospecți, și fără rândul ăsta cineva o va folosi așa.
const AVERTISMENT_CLIENTI = `<div class="flash" style="background:#eef2fb;border-color:#c8d4ee;color:var(--text)">
  <strong>Firmele de mai jos sunt clienții Sameday, nu ai noștri.</strong>
  Primesc de la noi prin curier, pe AWB-urile lui. Nu intră în sugestiile agenților și nu li se ofertează
  consumabilele pe care le cumpără prin Sameday — decizia e din 10.10.2026. Dacă un agent încearcă să
  introducă una din ele ca lead, ERP-ul îi spune de ce nu merge.
</div>`;

// ---- rutele -----------------------------------------------------------------

function register(router) {
  router.get(CALE, async (ctx) => {
    const lunaAzi = azi().slice(0, 7);
    const luna = /^\d{4}-\d{2}$/.test(String(ctx.query.luna || "")) ? ctx.query.luna : lunaAzi;
    const deLa = `${luna}-01`;
    const panaLa = ultimaZiDinLuna(luna);

    const produse = await db.prepare("SELECT * FROM consumabile_produse WHERE activ = 1 ORDER BY ordine").all();
    const [tLuna, tTot, pProd, zile] = await Promise.all([
      totalPerioada(deLa, panaLa),
      totalPerioada("0000-01-01", "9999-12-31"),
      peProdus(deLa, panaLa),
      peZi(deLa, panaLa),
    ]);

    const ultima = await db
      .prepare("SELECT data FROM consumabile_zile WHERE client = ? ORDER BY data DESC LIMIT 1")
      .get(CLIENT);
    const tUltima = ultima ? await totalPerioada(ultima.data, ultima.data) : { venit: 0, cost: 0, venit_fara_cost: 0, zile: 0 };

    const cuCostLuna = nr(tLuna.venit) - nr(tLuna.venit_fara_cost);
    const marjaLuna = cuCostLuna - nr(tLuna.cost);
    const acoperire = procent(cuCostLuna, nr(tLuna.venit));
    const mediaZi = nr(tLuna.zile) > 0 ? nr(tLuna.venit) / nr(tLuna.zile) : 0;

    // Ziua din formular: cea de azi dacă n-are deja date, altfel tot azi —
    // formularul se completează cu ce există, ca editarea să fie corectură,
    // nu rescriere oarbă.
    const ziForm = String(ctx.query.zi || azi());
    const existente = await db
      .prepare(
        `SELECT l.produs_id, l.cantitate FROM consumabile_linii l
           JOIN consumabile_zile z ON z.id = l.zi_id
          WHERE z.client = ? AND z.data = ?`
      )
      .all(CLIENT, ziForm);
    const cantitati = {};
    for (const e of existente) cantitati[e.produs_id] = nr(e.cantitate);

    // Clienții de pe AWB-uri. Topul de produse se cere într-o interogare pentru
    // toți cei din top, nu una per client.
    const [topuri, acop] = await Promise.all([topClienti(deLa, panaLa, 20), acoperireAwb(deLa, panaLa)]);
    const produseTop = await produseTopClienti(topuri.map((c) => Number(c.id)), deLa, panaLa, 3);

    // Legarea la nomenclator se calculează doar când e cerută: parcurge tot
    // nomenclatorul și n-are ce căuta la fiecare deschidere a raportului.
    const legare = String(ctx.query.legare || "") === "1" ? await sugestiiLegare(produse) : null;

    const luniSelect = [];
    for (let i = 0; i < 18; i++) luniSelect.push(lunaPlus(lunaAzi, -i));

    const corp = `
      <form class="filtre" method="get" action="${CALE}" style="margin-bottom:14px">
        <label>Luna
          <select name="luna" onchange="this.form.submit()">
            ${luniSelect.map((l) => `<option value="${l}"${l === luna ? " selected" : ""}>${etichetaLuna(l)}</option>`).join("")}
          </select>
        </label>
      </form>

      <div class="cards">
        ${cardulLunii(ultima ? `Ultima zi — ${dataRo(ultima.data)}` : "Ultima zi", tUltima)}
        ${cardulLunii(etichetaLuna(luna), tLuna)}
        ${cardulLunii("Cumulat, tot istoricul", tTot)}
        <div class="card">
          <div class="label">Media pe zi lucrătoare, ${etichetaLuna(luna)}</div>
          <div class="value">${money(mediaZi)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">din ${nr(tLuna.zile)} zile cu comenzi</div>
        </div>
      </div>

      ${
        acoperire < 99.5
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">Doar ${acoperire.toFixed(0)}% din venitul lunii are cost completat în spate. Marja de mai sus e marja produselor cu cost — restul nu e zero, e necunoscut. Completează costurile jos, în „Prețuri și costuri".</div>`
          : ""
      }

      <h2>Pe produs — ${esc(etichetaLuna(luna))}</h2>
      ${tabelProduse(pProd, marjaLuna)}

      <h2>Pe zi</h2>
      ${tabelZile(zile)}

      <h2>Clienții care au comandat — ${esc(etichetaLuna(luna))}</h2>
      ${AVERTISMENT_CLIENTI}
      ${
        nr(tLuna.venit) > 0 && nr(acop.venit_awb) < nr(tLuna.venit) * 0.995
          ? `<p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">Din ${money(tLuna.venit)} ai lunii, ${money(
              acop.venit_awb
            )} (${procent(acop.venit_awb, tLuna.venit).toFixed(0)}%) au AWB-uri în spate și se pot repartiza pe clienți. Restul sunt zile intrate de mână, înainte ca parsarea AWB-urilor să existe.</p>`
          : `<p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">${nr(acop.awb_uri).toLocaleString(
              "ro-RO"
            )} expediții, ${nr(acop.clienti)} clienți distincți în luna asta.</p>`
      }
      ${tabelTopClienti(topuri, produseTop, nr(acop.venit_awb))}

      <h2>Adaugă sau corectează o zi</h2>
      ${formularZi(produse, ziForm, cantitati)}

      <h2>Costul, luat din nomenclator</h2>
      <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">
        Costul nu se mai scrie de mână. Se leagă o dată produsul de comandă la produsul din nomenclator, iar apoi
        costul vine singur: <strong>din rețetă</strong> dacă îl facem noi, <strong>din ultima intrare de marfă</strong>
        dacă îl cumpărăm, iar la nevoie din prețul de achiziție scris pe produs. Un cost de peste cinci ori prețul
        de vânzare nu se acceptă — aia nu e marjă proastă, e legătură greșită.
      </p>
      ${legare ? formularLegare(produse, legare) : `<p><a class="btn secondary" href="${CALE}?luna=${luna}&legare=1">Arată legăturile la nomenclator</a></p>`}

      <h2>Încarcă AWB-urile unei zile</h2>
      <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">
        Lista de etichete, ca JSON: <code>[{"awb","data","kg","destinatar","adresa","oras","judet","agentie","articole":[{"cantitate","produs"}]}]</code>.
        <strong>Data e cea de pe etichetă</strong> — ziua de raport e cu o zi mai devreme, scăderea o face ERP-ul.
        Dă întâi „probă uscată": îți arată ziua calculată, fără să scrie nimic. Dacă un articol nu e recunoscut,
        nu se scrie nimic — nici parțial.
      </p>
      <form method="post" action="${CALE}/awb" class="form">
        <textarea name="json" rows="5" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" placeholder="[ … ]"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn secondary" type="submit" name="uscat" value="1">Probă uscată</button>
          <button class="btn" type="submit">Scrie zilele</button>
        </div>
      </form>

      <h2>Prețuri, aliasuri și costuri manuale</h2>
      <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">
        Prețul de aici se folosește la zilele pe care le salvezi de acum înainte. Zilele deja salvate își păstrează prețul lor —
        de-aia o creștere de preț nu rescrie istoricul. Costul lasă-l gol dacă nu-l știi: un zero ar face marja să pară 100%.
        Pentru plicul AWB C5 ai calculatorul la <a href="/calculator/awb">/calculator/awb</a>, pentru pungi la
        <a href="/calculator/pungi">/calculator/pungi</a>, pentru cutii la <a href="/calculator/cutii">/calculator/cutii</a>.
      </p>
      ${formularCosturi(produse)}
    `;
    send(ctx.res, 200, rapoarte.pagina(ctx, "Comenzi consumabile la zi", CALE, corp));
  });

  router.post(`${CALE}/zi`, async (ctx) => {
    const b = ctx.body || {};
    const data = String(b.data || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return redirect(ctx.res, CALE);

    const produse = await db.prepare("SELECT id, pret, cost FROM consumabile_produse WHERE activ = 1").all();
    let zi = await db.prepare("SELECT id FROM consumabile_zile WHERE client = ? AND data = ?").get(CLIENT, data);
    if (!zi) {
      const ins = await db
        .prepare("INSERT INTO consumabile_zile (client, data, sursa, creat_de) VALUES (?,?,?,?) RETURNING id")
        .run(CLIENT, data, "manual", ctx.user ? ctx.user.id : null);
      zi = { id: Number(ins.lastInsertRowid) };
    }

    for (const p of produse) {
      const brut = b[`c_${p.id}`];
      const cant = Number(String(brut == null ? "" : brut).replace(",", "."));
      if (!Number.isFinite(cant) || cant <= 0) {
        await db.prepare("DELETE FROM consumabile_linii WHERE zi_id = ? AND produs_id = ?").run(zi.id, p.id);
        continue;
      }
      await db
        .prepare(
          `INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret, cost)
           VALUES (?,?,?,?,?)
           ON CONFLICT (zi_id, produs_id) DO UPDATE SET cantitate = EXCLUDED.cantitate`
        )
        .run(zi.id, p.id, cant, nr(p.pret), p.cost == null ? null : nr(p.cost));
    }
    return redirect(ctx.res, `${CALE}?luna=${data.slice(0, 7)}&zi=${data}`);
  });

  router.post(`${CALE}/costuri`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const produse = await db.prepare("SELECT id, produs_id FROM consumabile_produse").all();
    for (const p of produse) {
      const pret = Number(String(b[`p_${p.id}`] || "").replace(",", "."));
      const aliasuri = String(b[`a_${p.id}`] || "").slice(0, 500).trim() || null;
      await db
        .prepare("UPDATE consumabile_produse SET pret = ?, aliasuri = ? WHERE id = ?")
        .run(Number.isFinite(pret) && pret >= 0 ? pret : 0, aliasuri, p.id);
      // Costul manual se mai poate scrie DOAR la produsele nelegate. La cele
      // legate, formularul nici nu trimite câmpul — iar dacă îl trimite cineva
      // de mână, nu-l luăm: altfel costul automat ar fi tăcut peste.
      if (p.produs_id) continue;
      const costBrut = String(b[`k_${p.id}`] == null ? "" : b[`k_${p.id}`]).trim();
      const cost = costBrut === "" ? null : Number(costBrut.replace(",", "."));
      await db
        .prepare("UPDATE consumabile_produse SET cost = ?, nota_cost = ?, cost_sursa = ? WHERE id = ?")
        .run(
          cost == null || !Number.isFinite(cost) ? null : cost,
          String(b[`n_${p.id}`] || "").slice(0, 200) || null,
          cost == null || !Number.isFinite(cost) ? null : "scris de mână",
          p.id
        );
    }
    return redirect(ctx.res, CALE);
  });

  // Legarea la nomenclator + recalculul costurilor, într-un singur drum.
  router.post(`${CALE}/legare`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const produse = await db.prepare("SELECT id FROM consumabile_produse").all();
    for (const p of produse) {
      const brut = String(b[`l_${p.id}`] == null ? "" : b[`l_${p.id}`]).trim();
      const id = brut === "" ? null : Number(brut);
      await db
        .prepare("UPDATE consumabile_produse SET produs_id = ? WHERE id = ?")
        .run(Number.isFinite(id) && id > 0 ? id : null, p.id);
    }
    const r = await recalculeazaCosturi();
    let umplut = { linii: 0, linii_awb: 0 };
    if (String(b.umple || "") === "1") umplut = await umpleCosturiLipsa();
    console.log(
      `[comenzi-zi] costuri recalculate: ${r.cu_cost}/${r.produse} produse cu cost, ${r.fara_cost} fără; linii umplute: ${umplut.linii} + ${umplut.linii_awb} pe AWB`
    );
    return redirect(ctx.res, `${CALE}?legare=1`);
  });

  // Fișa clientului de pe AWB. Aici stau adresa, agenția, ce cumpără și
  // AWB-urile lui — plus, scris o dată, de ce nu-i ofertăm.
  router.get(`${CALE}/client/:id`, async (ctx) => {
    const c = await clientulCu(ctx.params.id);
    if (!c) return send(ctx.res, 404, rapoarte.pagina(ctx, "Client negăsit", CALE, "<p>Clientul nu există.</p>"));

    const [produse, awburi, tot] = await Promise.all([
      produsePerClient(c.id, "0000-01-01", "9999-12-31"),
      awbClient(c.id, 80),
      db
        .prepare(
          `SELECT COUNT(DISTINCT a.id) AS awb_uri, COALESCE(SUM(a.colete), 0) AS colete,
                  COALESCE(SUM(a.kg), 0) AS kg
             FROM consumabile_awb a WHERE a.client_id = ?`
        )
        .get(c.id)
        .catch(() => ({ awb_uri: 0, colete: 0, kg: 0 })),
    ]);
    const venit = produse.reduce((s, p) => s + nr(p.venit), 0);
    const cuCost = venit - produse.reduce((s, p) => s + nr(p.venit_fara_cost), 0);
    const marja = cuCost - produse.reduce((s, p) => s + nr(p.cost), 0);

    const corp = `
      <p style="margin:0 0 10px"><a href="${CALE}">← Comenzi consumabile la zi</a></p>
      <h1 style="margin-top:0">${esc(c.nume)}</h1>
      <div class="flash" style="background:#eef2fb;border-color:#c8d4ee;color:var(--text)">
        ${cc.avertisment(c)}
      </div>
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Adresa de livrare</div>${esc(c.adresa || "—")}</div>
          <div><div class="k">Oraș / județ</div>${esc([c.oras, c.judet].filter(Boolean).join(", ") || "—")}</div>
          <div><div class="k">Agenția Sameday</div>${esc(c.agentie || "—")}</div>
          <div><div class="k">Prima comandă</div>${esc(dataRo(c.prima_comanda))}</div>
          <div><div class="k">Ultima comandă</div>${esc(dataRo(c.ultima_comanda))}</div>
          <div><div class="k">Expediții</div>${nr(tot.awb_uri).toLocaleString("ro-RO")}${
            nr(tot.colete) ? ` · ${nr(tot.colete).toLocaleString("ro-RO")} colete` : ""
          }${nr(tot.kg) ? ` · ${nr(tot.kg).toLocaleString("ro-RO", { maximumFractionDigits: 1 })} kg` : ""}</div>
          <div><div class="k">Venit, tot istoricul</div>${money(venit)}</div>
          <div><div class="k">Marjă</div>${cuCost > 0 ? `${money(marja)} · ${procent(marja, cuCost).toFixed(1)}%` : "necunoscută"}</div>
        </div>
        ${nr(c.trunchiat) ? `<p style="font-size:12px;color:var(--warn);margin:10px 0 0">Numele e tăiat de lățimea etichetei AWB, deci poate fi incomplet. Se completează singur când vine un AWB cu numele întreg.</p>` : ""}
      </div>

      <h2>Ce cumpără</h2>
      ${
        produse.length
          ? table(
              ["Produs", "Cantitate", "Venit", "Cost", "Marjă"],
              produse.map((p) => {
                const v = nr(p.venit);
                const cc2 = v - nr(p.venit_fara_cost);
                return [
                  esc(p.denumire),
                  nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "buc"),
                  money(v),
                  cc2 > 0 ? money(p.cost) : "—",
                  cc2 > 0 ? money(cc2 - nr(p.cost)) : "—",
                ];
              })
            )
          : '<p style="color:var(--text-muted)">Niciun produs — clientul are AWB-uri, dar fără linii recunoscute.</p>'
      }

      <h2>AWB-urile lui</h2>
      ${
        awburi.length
          ? table(
              ["Expediție", "Data etichetei", "Ziua de raport", "Colete", "Produse", "Valoare", "Greutate", "Agenție"],
              awburi.map((a) => [
                `<code>${esc(a.awb)}</code>`,
                dataRo(a.data_awb),
                dataRo(a.zi),
                nr(a.colete),
                nr(a.produse),
                money(a.venit),
                nr(a.kg) ? nr(a.kg).toLocaleString("ro-RO", { maximumFractionDigits: 2 }) + " kg" : "—",
                esc(a.agentie || "—"),
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun AWB.</p>'
      }
    `;
    send(ctx.res, 200, rapoarte.pagina(ctx, c.nume, CALE, corp));
  });

  // Importul AWB-urilor dintr-un JSON lipit în pagină.
  //
  // Jobul de noapte va trimite aici exact aceeași structură — ruta e una, ca să
  // nu existe două drumuri prin care datele intră în bază și să se comporte
  // diferit. „Probă uscată" calculează și arată ziua fără să scrie nimic; e
  // modul în care se verifică o zi înainte s-o accepți.
  router.post(`${CALE}/awb`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    let etichete;
    try {
      etichete = JSON.parse(String(b.json || "[]"));
      if (!Array.isArray(etichete)) throw new Error("JSON-ul trebuie să fie o listă de etichete");
    } catch (e) {
      return send(
        ctx.res,
        400,
        rapoarte.pagina(ctx, "AWB-uri — JSON greșit", CALE, `<p>Nu pot citi JSON-ul: ${esc(e.message)}</p><p><a href="${CALE}">Înapoi</a></p>`)
      );
    }
    const uscat = String(b.uscat || "") === "1";
    const r = await importaAwb(etichete, { uscat, userId: ctx.user ? ctx.user.id : null });
    if (!uscat && r.scris) await umpleCosturiLipsa();

    const corp = `
      <p style="margin:0 0 10px"><a href="${CALE}">← Comenzi consumabile la zi</a></p>
      <h1 style="margin-top:0">${uscat ? "Probă uscată" : "Import AWB"} — ${r.awb_uri} expediții din ${nr(
        r.etichete
      )} etichete (${nr(r.colete)} colete), ${r.zile.length} zile</h1>
      <p style="font-size:13px;color:var(--text-muted);margin:-6px 0 12px">
        Ultimele trei cifre ale AWB-ului sunt numărul coletului, iar eticheta fiecărui colet repetă comanda
        întreagă. De-aia se numără o dată pe expediție: altfel o comandă pe 60 de colete ar intra de 60 de ori.
      </p>
      ${r.motiv ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">${esc(r.motiv)}</div>` : ""}
      ${
        r.necunoscute.length
          ? `<h2>Articole pe care nu le recunosc</h2>
             <p style="font-size:13px;color:var(--text-muted)">Până primesc un alias pentru fiecare, ziua nu se scrie — nici parțial. Aliasurile se adaugă în „Prețuri, aliasuri și costuri manuale".</p>
             ${table(["Numele exact de pe etichetă", "Exemplu de AWB", "Cantitate"], r.necunoscute.map((n) => [`<code>${esc(n.nume)}</code>`, esc(n.awb), nr(n.cantitate)]))}`
          : ""
      }
      ${
        r.detaliu.length
          ? `<h2>Zilele</h2>${table(
              ["Ziua", "Expediții", "Colete", uscat ? "Venit calculat" : "Venit scris", uscat ? "Există deja?" : "Clienți"],
              r.detaliu.map((d) => [
                `<strong>${dataRo(d.zi)}</strong>`,
                nr(d.awb_uri),
                nr(d.colete),
                money(d.venit),
                uscat ? (d.exista_deja ? `da, sursa „${esc(d.sursa_existenta || "")}" — se rescrie` : "nu") : nr(d.clienti),
              ])
            )}`
          : ""
      }
      ${
        uscat && r.detaliu.length
          ? r.detaliu
              .map(
                (d) =>
                  `<h3>${dataRo(d.zi)} — pe produs</h3>${table(
                    ["Produs", "Cantitate", "Preț", "Valoare"],
                    d.linii.map((l) => [esc(l.denumire), nr(l.cantitate).toLocaleString("ro-RO"), money(l.pret), money(l.valoare)])
                  )}`
              )
              .join("")
          : ""
      }
      ${nr(r.fara_data) ? `<p style="color:var(--warn)">${nr(r.fara_data)} etichete fără AWB sau fără dată — sărite.</p>` : ""}
    `;
    send(ctx.res, 200, rapoarte.pagina(ctx, uscat ? "Probă uscată AWB" : "Import AWB", CALE, corp));
  });
}

module.exports = {
  register,
  seed,
  recalculeazaCosturi,
  umpleCosturiLipsa,
  importaAwb,
  ziuaDeRaport,
  // Expuse pentru teste: recunoașterea produsului e piesa de care atârnă jobul
  // de noapte, iar ea se verifică pe cele 419 etichete reale, nu din priviri.
  __test: { cheieExpeditie, grupeazaColete, cheieText, felProdus, codProdus, semnatura, indexeazaProduse, potrivesteProdus, scorPotrivire, costPlauzibil },
};
