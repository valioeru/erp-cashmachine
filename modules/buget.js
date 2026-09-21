"use strict";
// Bugetul de venituri și cheltuieli.
//
// DE CE, în cuvintele lui Vali: „un buget de venituri și cheltuieli detaliat
// cu posibilitate de alterare a câmpurilor, bazat pe ce am deja în Conta, cu
// comparație 2025 și 2026 și bugetat și realizat pe 2027; la coloanele mari de
// cheltuieli din balanță să pot sparge în mai multe conturi related cu
// categoria."
//
// Ideea care ține tot: LINIA DE BUGET E O CATEGORIE, nu un cont. Nimeni nu
// bugetează „contul 628", bugetează „servicii". Dar cifrele reale vin din
// balanță, care e pe conturi. Categoria strânge mai multe conturi, iar
// legătura se poate muta oricând — aduni trei conturi într-o categorie sau
// spargi una mare în trei — fără să atingi balanța.
//
// Trei reguli care fac diferența între un buget corect și unul care arată
// corect:
//
// 1. UN CONT ÎNTR-O SINGURĂ CATEGORIE. Altfel e numărat de două ori și
//    totalul iese mai mare decât realitatea, fără ca nimic să pară stricat.
//
// 2. CONTURILE NEACOPERITE SE ARATĂ. Dacă o categorie a uitat un cont, pagina
//    îl scoate la lumină cu suma lui. Un buget „complet" în care lipsesc
//    200.000 de lei dintr-un cont uitat e mai rău decât unul evident incomplet.
//
// 3. REALIZATUL NU SE INVENTEAZĂ. Vine din balanțele încărcate din SmartBill
//    Conta (/rapoarte/balanta/istoric). Dacă pentru un an nu există balanță,
//    coloana e goală și scrie de ce — nu se pune zero, fiindcă zero înseamnă
//    „n-am cheltuit", nu „nu știu".
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);
const eAdmin = (u) => Boolean(u && u.rol === "admin");
const AN_IMPLICIT = 2027;

// Câte luni acoperă o balanță — ca să putem anualiza un an în curs.
function luniAcoperite(deLa, panaLa) {
  const a = String(deLa || "").slice(0, 10);
  const b = String(panaLa || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return 12;
  const zile = Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1);
  return Math.max(0.5, Math.min(12, zile / 30.44));
}

// ---- categoriile implicite, după planul de conturi românesc ----------------
//
// Prefixul cel mai lung câștigă: „607" merge la „Mărfuri vândute", nu la
// „Materii prime" doar fiindcă începe cu „60". Fără regula asta, categoriile
// mari ar înghiți exact conturile pe care Vali vrea să le vadă separat.
const IMPLICITE = [
  // cheltuieli
  ["605", "cheltuiala", "Utilități", 20],
  ["607", "cheltuiala", "Mărfuri vândute", 10],
  ["60", "cheltuiala", "Materii prime și materiale", 15],
  ["612", "cheltuiala", "Chirii", 30],
  ["613", "cheltuiala", "Asigurări", 35],
  ["623", "cheltuiala", "Protocol, reclamă și publicitate", 45],
  ["624", "cheltuiala", "Transport", 50],
  ["625", "cheltuiala", "Deplasări și diurne", 55],
  ["626", "cheltuiala", "Poștă și telecomunicații", 60],
  ["627", "cheltuiala", "Comisioane bancare", 65],
  ["61", "cheltuiala", "Servicii executate de terți", 40],
  ["62", "cheltuiala", "Alte servicii executate de terți", 70],
  ["63", "cheltuiala", "Impozite și taxe", 75],
  ["641", "cheltuiala", "Salarii", 80],
  ["64", "cheltuiala", "Contribuții și alte cheltuieli de personal", 85],
  ["65", "cheltuiala", "Alte cheltuieli de exploatare", 90],
  ["666", "cheltuiala", "Dobânzi", 95],
  ["66", "cheltuiala", "Alte cheltuieli financiare", 100],
  ["681", "cheltuiala", "Amortizări și provizioane", 105],
  ["68", "cheltuiala", "Alte ajustări", 110],
  ["691", "cheltuiala", "Impozit pe profit", 120],
  ["69", "cheltuiala", "Alte impozite", 125],
  // venituri
  ["707", "venit", "Vânzări de mărfuri", 10],
  ["704", "venit", "Servicii prestate", 15],
  ["70", "venit", "Vânzări de produse și alte venituri din vânzări", 20],
  ["71", "venit", "Variația stocurilor", 25],
  ["72", "venit", "Producție imobilizată", 30],
  ["74", "venit", "Subvenții", 35],
  ["75", "venit", "Alte venituri din exploatare", 40],
  ["76", "venit", "Venituri financiare", 45],
  ["78", "venit", "Venituri din provizioane", 50],
];

function felulContului(cont) {
  const c = String(cont || "").trim();
  if (/^6/.test(c)) return "cheltuiala";
  if (/^7/.test(c)) return "venit";
  return null;
}

// Categoria implicită a unui cont: prefixul cel mai lung care se potrivește.
function categoriaImplicita(cont) {
  const c = String(cont || "").trim();
  let castig = null;
  for (const [prefix, fel, nume, ordine] of IMPLICITE) {
    if (!c.startsWith(prefix)) continue;
    if (!castig || prefix.length > castig.prefix.length) castig = { prefix, fel, nume, ordine };
  }
  return castig;
}

// ---- balanțele: ce s-a realizat, pe cont -----------------------------------
//
// Balanțele unui an, în ordinea perioadei, curățate de două feluri de gunoi:
//
// 1. „Balanța" cu un singur cont — o rulare eșuată a punții, nu o balanță.
//
// 2. BALANȚA VECHE CU PERIOADĂ LUNGĂ. Capcana adevărată, plătită pe date reale:
//    pe 14.09 s-a tras din Conta „01.01 → 14.09", dar contabila nu postase încă
//    august, așa că balanța aia conținea de fapt cifrele până la 31.07. Pe 19.09
//    s-a tras „01.01 → 31.08", cu august închis. Sortate după perioadă, cea de
//    pe 14.09 vine ULTIMA și pare cea mai proaspătă — și scădea 526.024,58 lei
//    din septembrie, ca și cum s-ar fi stornat vânzări.
//
//    Regula: parcurse în ordinea perioadei, o balanță trasă ÎNAINTE de una deja
//    acceptată care acoperă o perioadă mai scurtă e date vechi — n-avea de unde
//    să știe ce s-a înregistrat între timp. Se sare peste ea.
//    (Balanțele importate în același minut — cum vin lunile vechi, toate odată —
//    au aceeași oră, iar comparația e strictă, deci rămân toate.)
async function snapshoturileAnului(an) {
  const r = await db
    .prepare(
      `SELECT eticheta, MIN(data_de_la) AS de_la, MAX(data_pana) AS pana,
              COUNT(*) AS conturi, MAX(incarcat_la) AS incarcat
         FROM balante_snapshot
        WHERE SUBSTR(data_de_la, 1, 4) = ?
        GROUP BY eticheta
        ORDER BY MAX(data_pana) ASC, COUNT(*) ASC`
    )
    .all(String(an))
    .catch(() => []);
  const bune = [];
  const ignorate = [];
  let ultimaIncarcare = "";
  for (const x of r) {
    if (Number(x.conturi) <= 5) {
      ignorate.push({ ...x, motiv: `are doar ${x.conturi} ${Number(x.conturi) === 1 ? "cont" : "conturi"}` });
      continue;
    }
    const incarcat = String(x.incarcat || "");
    if (incarcat && ultimaIncarcare && incarcat < ultimaIncarcare) {
      ignorate.push({ ...x, motiv: `trasă din Conta pe ${zi(incarcat)}, înaintea balanței mai scurte de pe ${zi(ultimaIncarcare)}` });
      continue;
    }
    if (incarcat > ultimaIncarcare) ultimaIncarcare = incarcat;
    bune.push(x);
  }
  return { bune, ignorate };
}

function zi(t) {
  const m = String(t || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(t || "");
}

// Balanța de referință a unui an: ultima rămasă după curățenia de mai sus. Pe
// anii încheiați e balanța anuală, pe anul în curs e cea mai recentă VALIDĂ.
async function balantaAnului(an) {
  const { bune } = await snapshoturileAnului(an);
  return bune.length ? bune[bune.length - 1] : null;
}

// Rulajul pe cont, pentru conturile de venituri și cheltuieli.
//
// DOUĂ CAPCANE, amândouă deja plătite o dată în raportul de indicatori (vezi
// `rulaje` din modules/rapoarte.js — aceeași regulă, scrisă acolo întâi):
//
// 1. SmartBill Conta ÎNCHIDE LUNAR clasele 6 și 7 prin 121. Pe un cont de
//    venituri, creditul (venitul) și debitul (închiderea) ajung egale — deci
//    „credit minus debit" dă ZERO pe toată balanța. Partea adevărată e rulajul
//    care NU e închiderea: la venituri CREDITUL, la cheltuieli DEBITUL, fără
//    scădere. Prima versiune a paginii ăsteia scădea, și arăta un buget cu
//    toate veniturile pe zero — credibil la prima vedere, complet greșit.
//
// 2. Unele balanțe au coloana „rulaj" goală și doar „total sume" completată.
//    Atunci rulajul perioadei e total sume minus soldul inițial.
function rulajul(x, areTotaluri) {
  return areTotaluri
    ? { d: nr(x.ts_d) - nr(x.si_d), c: nr(x.ts_c) - nr(x.si_c) }
    : { d: nr(x.r_d), c: nr(x.r_c) };
}

async function realizatPeCont(eticheta) {
  const harta = new Map();
  if (!eticheta) return harta;
  const randuri = await db
    .prepare("SELECT cont, denumire, si_d, si_c, r_d, r_c, ts_d, ts_c FROM balante_snapshot WHERE eticheta = ?")
    .all(eticheta)
    .catch(() => []);
  const areTotaluri = randuri.some((x) => nr(x.ts_d) !== 0 || nr(x.ts_c) !== 0);
  for (const x of randuri) {
    const cont = String(x.cont || "").trim();
    const fel = felulContului(cont);
    if (!fel) continue;
    // Doar conturile de detaliu: balanța conține și rândurile de grup („60",
    // „6"), iar adunându-le pe toate am număra de două-trei ori aceeași sumă.
    if (cont.length < 3) continue;
    const r = rulajul(x, areTotaluri);
    // 709 („reduceri comerciale acordate") e un cont de venituri cu sold
    // debitor: scade din cifra de afaceri, nu se adună la ea.
    const val = fel === "cheltuiala" ? r.d : cont.startsWith("709") ? -r.d : r.c;
    harta.set(cont, { cont, denumire: x.denumire || "", fel, val });
  }
  // Un cont sintetic rămas (ex. „607") când există și analiticele lui
  // („6071") ar dubla suma. Se scoate sinteticul dacă are copii.
  for (const cont of [...harta.keys()]) {
    for (const alt of harta.keys()) {
      if (alt !== cont && alt.startsWith(cont)) {
        harta.delete(cont);
        break;
      }
    }
  }
  return harta;
}

const LUNI = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "nov", "dec"];

// ---- realizatul pe LUNĂ, pe cont --------------------------------------------
//
// Balanțele din Conta sunt CUMULATE de la 1 ianuarie: „la 31.03" conține și
// ianuarie, și februarie. Luna în sine e diferența față de balanța precedentă.
// Dacă s-ar citi direct, martie ar apărea de trei ori mai mare decât e, și ar
// arăta perfect plauzibil.
//
// O lună fără balanță rămâne null, nu zero: „n-am încărcat balanța" și „n-am
// cheltuit nimic" sunt două lucruri diferite, iar confundate ar strica și
// graficul, și diferența față de buget.
async function realizatLunar(an) {
  const { bune, ignorate } = await snapshoturileAnului(an);
  const peLuna = new Map(); // cont -> [12] (null = lună fără balanță)
  const acoperite = new Array(12).fill(false);
  let cumulatAnterior = new Map();
  let lunaAnterioara = 0;

  for (const e of bune) {
    const luna = Number(String(e.pana).slice(5, 7));
    if (!luna || luna < 1 || luna > 12) continue;
    // Două balanțe pentru aceeași lună: contează ultima, deja sortate crescător.
    const cumulat = await realizatPeCont(e.eticheta);
    for (const [cont, x] of cumulat) {
      if (!peLuna.has(cont)) peLuna.set(cont, new Array(12).fill(null));
      const anterior = cumulatAnterior.has(cont) ? cumulatAnterior.get(cont).val : 0;
      peLuna.get(cont)[luna - 1] = x.val - anterior;
    }
    // Un cont care exista înainte și lipsește acum n-a mai mișcat: zero, nu gol.
    for (const [cont] of cumulatAnterior) {
      if (cumulat.has(cont)) continue;
      if (!peLuna.has(cont)) peLuna.set(cont, new Array(12).fill(null));
      peLuna.get(cont)[luna - 1] = 0;
    }
    for (let l = lunaAnterioara + 1; l <= luna; l++) acoperite[l - 1] = true;
    cumulatAnterior = cumulat;
    lunaAnterioara = luna;
  }
  // Lunile dintre două balanțe (ex. avem 31.01 și 31.03, lipsește februarie)
  // primesc diferența pe ultima lună acoperită — nu se poate despărți mai fin.
  return { peLuna, acoperite, ignorate };
}

// ---- cifrele scrise de om, pe lună și pe subcont -----------------------------
async function valorileBuget(an) {
  const randuri = await db
    .prepare("SELECT categorie_id, cont, luna, suma FROM buget_valori WHERE an = ?")
    .all(an)
    .catch(() => []);
  const h = new Map();
  for (const r of randuri)
    h.set(`${Number(r.categorie_id)}|${r.cont == null ? "" : String(r.cont)}|${Number(r.luna)}`, nr(r.suma));
  return h;
}

// Bugetul efectiv al unei categorii pe o lună, și DE UNDE vine.
// Ordinea nu e o preferință de stil: e singura care face ca detaliul scris de
// om să nu fie înghițit de o cifră mai veche, mai grosieră.
function bugetLuna(cat, luna, valori) {
  let dinConturi = 0;
  let areConturi = false;
  for (const cont of cat.conturi) {
    const v = valori.get(`${cat.id}|${cont}|${luna}`);
    if (v !== undefined) {
      dinConturi += v;
      areConturi = true;
    }
  }
  if (areConturi) return { suma: dinConturi, din: "subconturi" };
  const peCategorie = valori.get(`${cat.id}||${luna}`);
  if (peCategorie !== undefined) return { suma: peCategorie, din: "categorie" };
  return { suma: nr(cat.bugetat) / 12, din: "anual/12" };
}

// ---- categoriile anului -----------------------------------------------------
async function categoriile(an) {
  const cat = await db
    .prepare("SELECT id, an, fel, nume, ordine, bugetat, nota FROM buget_categorii WHERE an = ? ORDER BY fel DESC, ordine, nume")
    .all(an);
  const legaturi = await db
    .prepare(
      `SELECT bc.categorie_id, bc.cont FROM buget_conturi bc
         JOIN buget_categorii c ON c.id = bc.categorie_id
        WHERE c.an = ? ORDER BY bc.cont`
    )
    .all(an);
  const peCategorie = new Map(cat.map((c) => [Number(c.id), []]));
  for (const l of legaturi) {
    const k = Number(l.categorie_id);
    if (peCategorie.has(k)) peCategorie.get(k).push(String(l.cont));
  }
  return cat.map((c) => ({ ...c, id: Number(c.id), conturi: peCategorie.get(Number(c.id)) || [] }));
}

// Prima deschidere a unui an: se construiesc categoriile din conturile care
// chiar apar în balanțe, nu dintr-o listă teoretică. Altfel ar ieși treizeci
// de rânduri goale prin care trebuie să te uiți ca să găsești cele opt reale.
async function seamanaAn(an, conturiCunoscute) {
  const existente = await db.prepare("SELECT COUNT(*) AS n FROM buget_categorii WHERE an = ?").get(an);
  if (Number(existente.n) > 0) return 0;
  const dupaNume = new Map();
  for (const cont of conturiCunoscute) {
    const im = categoriaImplicita(cont);
    if (!im) continue;
    const cheie = im.fel + "|" + im.nume;
    if (!dupaNume.has(cheie)) dupaNume.set(cheie, { ...im, conturi: [] });
    dupaNume.get(cheie).conturi.push(cont);
  }
  let n = 0;
  for (const c of dupaNume.values()) {
    const r = await db
      .prepare("INSERT INTO buget_categorii (an, fel, nume, ordine) VALUES (?, ?, ?, ?) RETURNING id")
      .run(an, c.fel, c.nume, c.ordine);
    for (const cont of c.conturi)
      await db
        .prepare("INSERT INTO buget_conturi (categorie_id, cont) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(r.lastInsertRowid, cont);
    n++;
  }
  return n;
}

// ---- tabloul întreg ---------------------------------------------------------
async function tabloul(an) {
  const anii = { doiAnteriori: an - 2, anterior: an - 1, curent: an };
  const sAnte2 = await snapshoturileAnului(anii.doiAnteriori);
  const sAnte1 = await snapshoturileAnului(anii.anterior);
  const sCurent = await snapshoturileAnului(anii.curent);
  const ultima = (s) => (s.bune.length ? s.bune[s.bune.length - 1] : null);
  const bAnte2 = ultima(sAnte2);
  const bAnte1 = ultima(sAnte1);
  const bCurent = ultima(sCurent);
  // Balanțele sărite peste (vechi sau rupte) se spun pe față: altfel cifra pare
  // pur și simplu alta decât în Conta și nu se înțelege de ce.
  const ignorate = []
    .concat(sAnte2.ignorate, sAnte1.ignorate, sCurent.ignorate)
    .filter((x) => !String(x.motiv).startsWith("are doar"));

  const rAnte2 = await realizatPeCont(bAnte2 && bAnte2.eticheta);
  const rAnte1 = await realizatPeCont(bAnte1 && bAnte1.eticheta);
  const rCurent = await realizatPeCont(bCurent && bCurent.eticheta);

  const luniAnte1 = bAnte1 ? luniAcoperite(bAnte1.de_la, bAnte1.pana) : 12;
  const factorAnte1 = luniAnte1 >= 11.5 ? 1 : 12 / luniAnte1;

  // Toate conturile de venit/cheltuială văzute în oricare din balanțe.
  const toate = new Map();
  for (const h of [rAnte2, rAnte1, rCurent])
    for (const [cont, x] of h) if (!toate.has(cont)) toate.set(cont, x);

  await seamanaAn(an, [...toate.keys()]);
  const cat = await categoriile(an);

  // Un cont în două categorii ar fi numărat de două ori. Se semnalează.
  const apartenenta = new Map();
  const dublate = [];
  for (const c of cat)
    for (const cont of c.conturi) {
      if (apartenenta.has(cont)) dublate.push({ cont, unde: [apartenenta.get(cont).nume, c.nume] });
      else apartenenta.set(cont, c);
    }

  const valori = await valorileBuget(an);
  const val = (h, cont) => (h.has(cont) ? h.get(cont).val : 0);
  const randuri = cat.map((c) => {
    // Bugetul efectiv: suma celor 12 luni, fiecare luată de la nivelul cel mai
    // detaliat la care s-a scris ceva. Coloana anuală rămâne editabilă, dar
    // nu mai e singurul adevăr — de-aia se arată alături și de unde vine.
    const peLuni = Array.from({ length: 12 }, (_, i) => bugetLuna({ ...c, id: Number(c.id) }, i + 1, valori));
    const bugetatEfectiv = peLuni.reduce((x, y) => x + y.suma, 0);
    const surse = [...new Set(peLuni.map((x) => x.din))];
    const a2 = c.conturi.reduce((s, x) => s + val(rAnte2, x), 0);
    const a1 = c.conturi.reduce((s, x) => s + val(rAnte1, x), 0);
    const ac = c.conturi.reduce((s, x) => s + val(rCurent, x), 0);
    return {
      ...c,
      ante2: a2,
      ante1: a1,
      ante1Anualizat: a1 * factorAnte1,
      realizat: ac,
      bugetat: bugetatEfectiv,
      bugetatAnual: nr(c.bugetat),
      surse,
      detaliat: surse.some((x) => x !== "anual/12"),
      diferenta: ac - bugetatEfectiv,
      detalii: c.conturi.map((cont) => ({
        cont,
        denumire: (toate.get(cont) || {}).denumire || "",
        ante2: val(rAnte2, cont),
        ante1: val(rAnte1, cont),
        realizat: val(rCurent, cont),
      })),
    };
  });

  // Conturile pe care nicio categorie nu le-a prins. Ăsta e rândul care
  // împiedică un buget să pară complet când nu e.
  const neacoperite = [];
  for (const [cont, x] of toate) {
    if (apartenenta.has(cont)) continue;
    if (!val(rAnte2, cont) && !val(rAnte1, cont) && !val(rCurent, cont)) continue;
    neacoperite.push({
      cont,
      denumire: x.denumire,
      fel: x.fel,
      ante2: val(rAnte2, cont),
      ante1: val(rAnte1, cont),
      realizat: val(rCurent, cont),
    });
  }
  neacoperite.sort((a, b) => Math.abs(b.ante1) - Math.abs(a.ante1));

  const total = (lista, camp) => lista.reduce((s, r) => s + nr(r[camp]), 0);
  const venituri = randuri.filter((r) => r.fel === "venit");
  const cheltuieli = randuri.filter((r) => r.fel === "cheltuiala");

  return {
    an,
    anii,
    balante: { ante2: bAnte2, ante1: bAnte1, curent: bCurent },
    balanteIgnorate: ignorate,
    luniAnte1,
    factorAnte1,
    venituri,
    cheltuieli,
    dublate,
    neacoperite,
    totaluri: {
      venituri: {
        ante2: total(venituri, "ante2"),
        ante1: total(venituri, "ante1"),
        ante1Anualizat: total(venituri, "ante1Anualizat"),
        bugetat: total(venituri, "bugetat"),
        realizat: total(venituri, "realizat"),
      },
      cheltuieli: {
        ante2: total(cheltuieli, "ante2"),
        ante1: total(cheltuieli, "ante1"),
        ante1Anualizat: total(cheltuieli, "ante1Anualizat"),
        bugetat: total(cheltuieli, "bugetat"),
        realizat: total(cheltuieli, "realizat"),
      },
    },
  };
}

// Cifrele scrise de om: „1.234,50" și „1234.5" sunt același număr.
function suma(v) {
  const s = String(v == null ? "" : v).trim().replace(/\s/g, "");
  if (s === "") return 0;
  const curat = s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(curat);
  return Number.isFinite(n) ? n : 0;
}

async function scrieValoare(an, categorieId, cont, luna, valoare) {
  await db
    .prepare(
      `INSERT INTO buget_valori (an, luna, categorie_id, cont, suma) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (an, luna, categorie_id, COALESCE(cont, '')) DO UPDATE SET suma = EXCLUDED.suma`
    )
    .run(an, luna, categorieId, cont, valoare);
}

async function stergeValoare(an, categorieId, cont, luna) {
  await db
    .prepare(
      `DELETE FROM buget_valori WHERE an = ? AND luna = ? AND categorie_id = ? AND COALESCE(cont, '') = ?`
    )
    .run(an, luna, categorieId, cont == null ? "" : cont);
}

const procent = (parte, tot) => (Number(tot) ? (Number(parte) / Number(tot)) * 100 : 0);
const pct = (parte, tot) =>
  `<span style="color:var(--text-muted);font-size:12px">${procent(parte, tot).toFixed(1).replace(".", ",")}%</span>`;

function register(router) {
  router.get("/buget", async (ctx) => redirect(ctx.res, `/buget/${AN_IMPLICIT}`));

  router.get("/buget/:an", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    if (!an || an < 2020 || an > 2100) return redirect(ctx.res, `/buget/${AN_IMPLICIT}`);
    const d = await tabloul(an);
    const t = d.totaluri;

    const capete = [
      "Categorie",
      `${d.anii.doiAnteriori}`,
      `${d.anii.anterior}`,
      `${d.anii.anterior} anualizat`,
      `<strong>${an} bugetat</strong>`,
      `${an} realizat`,
      "Diferență",
      "Conturi",
    ];

    const randul = (r, totalFel) => [
      `<strong>${esc(r.nume)}</strong>`,
      money(r.ante2),
      `${money(r.ante1)}<br>${pct(r.ante1, totalFel.ante1)}`,
      money(r.ante1Anualizat),
      `<input name="b_${r.id}" value="${nr(r.bugetatAnual) ? String(Math.round(nr(r.bugetatAnual) * 100) / 100).replace(".", ",") : ""}" inputmode="decimal" style="width:120px;text-align:right">
         <div style="font-size:11px;margin-top:3px">
           <a href="/buget/${an}/categorie/${r.id}">pe luni și subconturi →</a>
         </div>
         ${
           r.detaliat
             ? `<div style="font-size:11px;color:var(--success)">intră ${money(r.bugetat)} (${esc(r.surse.join(", "))})</div>`
             : ""
         }`,
      money(r.realizat),
      nr(r.bugetat)
        ? `<span style="color:${r.diferenta > 0 ? "var(--warn)" : "var(--success)"}">${money(r.diferenta)}</span>`
        : '<span style="color:var(--text-muted)">—</span>',
      `<details><summary style="font-size:12px;cursor:pointer">${r.conturi.length} conturi</summary>
         <div style="font-size:12px;padding:6px 0">
           ${
             r.detalii.length
               ? r.detalii
                   .map(
                     (x) =>
                       `<div style="display:flex;gap:8px;justify-content:space-between;padding:2px 0">
                          <span><strong>${esc(x.cont)}</strong> ${esc(String(x.denumire).slice(0, 40))}</span>
                          <span style="white-space:nowrap">${money(x.ante1)}
                            <button type="submit" name="scoate" value="${esc(x.cont)}" class="link-btn" style="margin-left:6px">scoate</button>
                          </span>
                        </div>`
                   )
                   .join("")
               : '<span style="color:var(--text-muted)">niciun cont — categoria nu aduce nicio cifră</span>'
           }
         </div></details>`,
    ];

    const randTotal = (eticheta, tt) => [
      `<strong>${eticheta}</strong>`,
      `<strong>${money(tt.ante2)}</strong>`,
      `<strong>${money(tt.ante1)}</strong>`,
      `<strong>${money(tt.ante1Anualizat)}</strong>`,
      `<strong>${money(tt.bugetat)}</strong>`,
      `<strong>${money(tt.realizat)}</strong>`,
      "",
      "",
    ];

    const faraBalanta = (b, anul) =>
      b
        ? ""
        : `<p style="color:var(--warn);font-size:13px;margin:6px 0">Nu există balanță încărcată pentru ${anul} — coloana rămâne goală.
             <a href="/rapoarte/balanta/istoric">Încarcă una</a>.</p>`;

    const aniDeAles = [an - 1, an, an + 1];
    const body = `
      <div class="subnav">
        ${aniDeAles
          .map((x) => `<a href="/buget/${x}" class="subnav-link${x === an ? " activ" : ""}">Buget ${x}</a>`)
          .join("")}
        <a href="/rapoarte/balanta/istoric" class="subnav-link">Balanțele din Conta</a>
      </div>
      <h1 style="margin:6px 0 2px">Buget ${an} — venituri și cheltuieli</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:960px">
        Cifrele realizate vin din balanțele încărcate din SmartBill Conta — nu sunt estimate.
        Bugetul îl scrii tu în coloana <strong>${an} bugetat</strong>. O categorie strânge mai multe conturi:
        desfă „conturi" ca să vezi ce e înăuntru și să muți ce nu-i la locul lui.
      </p>
      ${faraBalanta(d.balante.ante2, d.anii.doiAnteriori)}
      ${faraBalanta(d.balante.ante1, d.anii.anterior)}
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 14px">
        Sursa: ${[d.balante.ante2, d.balante.ante1, d.balante.curent]
          .filter(Boolean)
          .map((b) => `${esc(b.eticheta)} (${esc(String(b.de_la).slice(0, 10))} → ${esc(String(b.pana).slice(0, 10))})`)
          .join(" · ") || "nicio balanță"}.
        ${
          d.factorAnte1 !== 1
            ? `Anualizarea lui ${d.anii.anterior} înmulțește cifra la zi cu ${(d.factorAnte1).toFixed(2).replace(".", ",")} — balanța acoperă ${d.luniAnte1.toFixed(1).replace(".", ",")} luni.`
            : ""
        }
      </p>
      ${
        d.balanteIgnorate.length
          ? `<p style="font-size:12px;color:var(--warn);margin:-8px 0 14px">
               Sărită: ${d.balanteIgnorate
                 .map((b) => `<strong>${esc(b.eticheta)}</strong> — ${esc(b.motiv)}`)
                 .join(" · ")}.
               O balanță trasă înaintea alteia mai scurte conține date mai vechi decât ea; luată în calcul,
               ar scădea din lunile deja închise sume care n-au fost stornate niciodată.
               <a href="/rapoarte/balanta/istoric">Vezi balanțele</a>.</p>`
          : ""
      }

      <div class="cards">
        <div class="card"><div class="label">Venituri bugetate ${an}</div><div class="value">${money(t.venituri.bugetat)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${d.anii.anterior} anualizat: ${money(t.venituri.ante1Anualizat)}</div></div>
        <div class="card"><div class="label">Cheltuieli bugetate ${an}</div><div class="value">${money(t.cheltuieli.bugetat)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${d.anii.anterior} anualizat: ${money(t.cheltuieli.ante1Anualizat)}</div></div>
        <div class="card"><div class="label">Rezultat bugetat ${an}</div>
          <div class="value" style="color:${t.venituri.bugetat - t.cheltuieli.bugetat >= 0 ? "var(--success)" : "var(--danger)"}">${money(t.venituri.bugetat - t.cheltuieli.bugetat)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${d.anii.anterior}: ${money(t.venituri.ante1 - t.cheltuieli.ante1)}</div></div>
        <div class="card"><div class="label">Rezultat realizat ${an}</div>
          <div class="value">${money(t.venituri.realizat - t.cheltuieli.realizat)}</div></div>
      </div>

      ${
        d.dublate.length
          ? `<p style="margin:14px 0 0;color:var(--danger);font-size:13px">
               <strong>${d.dublate.length} conturi sunt în două categorii deodată</strong> — sumele lor se numără de două ori:
               ${d.dublate.map((x) => esc(x.cont) + " (" + x.unde.map(esc).join(" și ") + ")").join(", ")}
             </p>`
          : ""
      }

      <form method="post" action="/buget/${an}/salveaza">
        <div class="toolbar" style="margin:16px 0 10px;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn" type="submit">Salvează bugetul</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            creștere
            <input name="crestere" id="crestere" value="0" inputmode="decimal" style="width:70px;text-align:right">
            <span>%</span>
          </label>
          <button class="btn secondary" type="submit" name="prepopuleaza" value="1"
                  onclick="return confirm('Pun în coloana bugetat cifrele din ${d.anii.anterior} anualizate, crescute cu procentul scris, peste ce e acum?')">
            Pornește de la ${d.anii.anterior} anualizat <span id="et-crestere"></span>
          </button>
          <span style="font-size:12px;color:var(--text-muted)">
            Procentul se aplică la fiecare linie, și la venituri și la cheltuieli. Poate fi și negativ.
          </span>
        </div>

        <h2>Venituri</h2>
        ${table(capete, d.venituri.map((r) => randul(r, t.venituri)).concat([randTotal("TOTAL VENITURI", t.venituri)]))}

        <h2>Cheltuieli</h2>
        ${table(capete, d.cheltuieli.map((r) => randul(r, t.cheltuieli)).concat([randTotal("TOTAL CHELTUIELI", t.cheltuieli)]))}

        <div class="form-actions"><button class="btn" type="submit">Salvează bugetul</button></div>
      </form>

      <h2>Conturi neprinse de nicio categorie</h2>
      ${
        d.neacoperite.length
          ? `<p style="font-size:13px;color:var(--danger);max-width:900px">
               Conturile astea au cifre în balanță dar nu intră în nicio linie de buget — deci totalurile de mai sus
               sunt <strong>mai mici decât realitatea</strong> cu suma lor. Pune fiecare într-o categorie.
             </p>
             ${table(
               ["Cont", "Denumire", "Fel", `${d.anii.doiAnteriori}`, `${d.anii.anterior}`, `${an}`, "Pune în"],
               d.neacoperite.slice(0, 60).map((x) => [
                 `<strong>${esc(x.cont)}</strong>`,
                 esc(String(x.denumire).slice(0, 50)),
                 x.fel === "venit" ? "venit" : "cheltuială",
                 money(x.ante2),
                 money(x.ante1),
                 money(x.realizat),
                 `<form method="post" action="/buget/${an}/muta" class="inline-form">
                    <input type="hidden" name="cont" value="${esc(x.cont)}">
                    <select name="categorie_id">
                      ${(x.fel === "venit" ? d.venituri : d.cheltuieli)
                        .map((c) => `<option value="${c.id}">${esc(c.nume)}</option>`)
                        .join("")}
                    </select>
                    <button class="link-btn" type="submit">pune</button>
                  </form>`,
               ])
             )}`
          : '<p style="color:var(--success)">Toate conturile de venituri și cheltuieli din balanță sunt prinse într-o categorie.</p>'
      }

      <script>
        (function () {
          var c = document.getElementById("crestere");
          var e = document.getElementById("et-crestere");
          if (!c || !e) return;
          function arata() {
            var v = String(c.value || "").replace(",", ".").trim();
            var n = Number(v);
            e.textContent = !v || !isFinite(n) || n === 0 ? "" : (n > 0 ? "+" : "") + v + "%";
          }
          c.addEventListener("input", arata);
          arata();
        })();
      </script>

      <h2>Categorie nouă</h2>
      <form method="post" action="/buget/${an}/categorie" class="filtre">
        <input name="nume" placeholder="numele categoriei" required style="min-width:240px">
        <select name="fel"><option value="cheltuiala">cheltuială</option><option value="venit">venit</option></select>
        <button class="btn secondary small" type="submit">Adaugă</button>
      </form>`;

    send(ctx.res, 200, layout({ user: ctx.user, title: `Buget ${an}`, active: "/buget", body }));
  });

  // ---- o categorie, pe luni și pe subconturi ------------------------------
  // Ruta asta stă DUPĂ „/buget/:an" ca literal, dar are patru segmente, deci
  // nu se ciocnesc (routerul compară pe număr de segmente). test-rute.js
  // verifică oricum la fiecare rulare.
  router.get("/buget/:an/categorie/:id", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    const id = parseInt(ctx.params.id, 10);
    if (!an || !id) return redirect(ctx.res, `/buget/${AN_IMPLICIT}`);
    const cat = (await categoriile(an)).find((c) => c.id === id);
    if (!cat) return redirect(ctx.res, `/buget/${an}`);

    const valori = await valorileBuget(an);
    const { peLuna, acoperite } = await realizatLunar(an);
    const anterior = await realizatLunar(an - 1);
    const numeCont = await realizatPeCont((await balantaAnului(an - 1) || {}).eticheta);

    const lunaCap = LUNI.map((l, i) => `${l}${acoperite[i] ? "" : " *"}`);
    const capete = ["Rând"].concat(lunaCap).concat(["Total an"]);

    const celula = (cont, luna) => {
      const cheie = `${cat.id}|${cont || ""}|${luna}`;
      const v = valori.get(cheie);
      return `<input name="v_${cont || "_"}_${luna}" value="${v === undefined ? "" : String(Math.round(v * 100) / 100).replace(".", ",")}" inputmode="decimal" style="width:82px;text-align:right">`;
    };
    const totalScris = (cont) => {
      let t = 0;
      let are = false;
      for (let l = 1; l <= 12; l++) {
        const v = valori.get(`${cat.id}|${cont || ""}|${l}`);
        if (v !== undefined) { t += v; are = true; }
      }
      return are ? t : null;
    };

    const randConturi = cat.conturi.map((cont) => {
      const tt = totalScris(cont);
      return [
        `<strong>${esc(cont)}</strong><br><span style="font-size:11px;color:var(--text-muted)">${esc(
          String((numeCont.get(cont) || {}).denumire || "").slice(0, 28)
        )}</span>`,
      ]
        .concat(Array.from({ length: 12 }, (_, i) => celula(cont, i + 1)))
        .concat([tt === null ? '<span style="color:var(--text-muted)">—</span>' : `<strong>${money(tt)}</strong>`]);
    });

    const ttCat = totalScris(null);
    const randCategorie = [
      `<strong>Pe categorie</strong><br><span style="font-size:11px;color:var(--text-muted)">fără defalcare</span>`,
    ]
      .concat(Array.from({ length: 12 }, (_, i) => celula(null, i + 1)))
      .concat([ttCat === null ? '<span style="color:var(--text-muted)">—</span>' : `<strong>${money(ttCat)}</strong>`]);

    // Bugetul care intră efectiv în total, lună cu lună, cu sursa lui.
    const efectiv = Array.from({ length: 12 }, (_, i) => bugetLuna(cat, i + 1, valori));
    const randEfectiv = ["<strong>Intră în buget</strong>"]
      .concat(
        efectiv.map(
          (e) =>
            `<strong>${money(e.suma)}</strong><br><span style="font-size:10px;color:var(--text-muted)">${esc(e.din)}</span>`
        )
      )
      .concat([`<strong>${money(efectiv.reduce((a, b) => a + b.suma, 0))}</strong>`]);

    const realizatLuni = Array.from({ length: 12 }, (_, i) =>
      cat.conturi.reduce((s, cont) => {
        const v = (peLuna.get(cont) || [])[i];
        return v === null || v === undefined ? s : s + v;
      }, 0)
    );
    const randRealizat = ["<strong>Realizat</strong>"]
      .concat(realizatLuni.map((v, i) => (acoperite[i] ? money(v) : '<span style="color:var(--text-muted)">—</span>')))
      .concat([`<strong>${money(realizatLuni.reduce((a, b) => a + b, 0))}</strong>`]);

    const randDiferenta = ["<strong>Diferență</strong>"]
      .concat(
        realizatLuni.map((v, i) => {
          if (!acoperite[i]) return '<span style="color:var(--text-muted)">—</span>';
          const dif = v - efectiv[i].suma;
          return `<span style="color:${dif > 0 ? "var(--warn)" : "var(--success)"}">${money(dif)}</span>`;
        })
      )
      .concat([""]);

    const anteriorLuni = Array.from({ length: 12 }, (_, i) =>
      cat.conturi.reduce((s, cont) => {
        const v = (anterior.peLuna.get(cont) || [])[i];
        return v === null || v === undefined ? s : s + v;
      }, 0)
    );
    // Aceeași regulă ca pe anul curent: o lună fără balanță e necunoscută, nu
    // zero. Pe anul trecut se vede cel mai des — balanțele se încarcă din mers.
    const randAnterior = [`<strong>${an - 1} realizat</strong>`]
      .concat(
        anteriorLuni.map((v, i) =>
          anterior.acoperite[i] ? money(v) : '<span style="color:var(--text-muted)">—</span>'
        )
      )
      .concat([
        `<strong>${money(anteriorLuni.reduce((a, b, i) => (anterior.acoperite[i] ? a + b : a), 0))}</strong>`,
      ]);

    const body = `
      <div class="toolbar" style="margin-bottom:10px">
        <a class="btn secondary" href="/buget/${an}">← Înapoi la bugetul ${an}</a>
      </div>
      <h1 style="margin:6px 0 2px">${esc(cat.nume)} · ${an}</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        Scrii în celule: pe subcont și pe lună, sau pe categorie dacă nu vrei să defalci.
        <strong>Suma subconturilor bate cifra de categorie</strong>, iar cifra de categorie bate anualul împărțit la 12 —
        rândul „Intră în buget" arată, pentru fiecare lună, ce cifră contează și de unde vine.
        ${acoperite.includes(false) ? "Lunile cu * n-au balanță încărcată, deci realizatul lor e necunoscut, nu zero." : ""}
        ${anterior.acoperite.includes(false) ? `La fel pe ${an - 1}: lunile fără balanță apar „—", iar totalul anului le sare.` : ""}
      </p>

      <form method="post" action="/buget/${an}/categorie/${cat.id}">
        <div class="toolbar" style="margin:0 0 10px;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn" type="submit">Salvează</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            împarte pe 12 suma
            <input name="imparte" inputmode="decimal" style="width:120px;text-align:right">
          </label>
          <button class="btn secondary" type="submit" name="actiune" value="imparte">Pune pe toate lunile</button>
          <span style="font-size:12px;color:var(--text-muted)">Scrie o sumă anuală și o întinde egal pe cele 12 luni, pe rândul „Pe categorie".</span>
        </div>
        ${table(capete, randConturi.concat([randCategorie, randEfectiv, randRealizat, randDiferenta, randAnterior]))}
        <div class="form-actions"><button class="btn" type="submit">Salvează</button></div>
      </form>

      <p style="font-size:12px;color:var(--text-muted);max-width:900px">
        Realizatul pe lună se calculează ca diferența dintre balanța cumulată a lunii și cea a lunii precedente —
        balanțele din Conta sunt cumulate de la 1 ianuarie. Dacă lipsește o lună de la mijloc, diferența ei
        se adună la prima lună cu balanță de după.
      </p>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: `${cat.nume} · ${an}`, active: "/buget", body }));
  });

  router.post("/buget/:an/categorie/:id", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    const id = parseInt(ctx.params.id, 10);
    const cat = (await categoriile(an)).find((c) => c.id === id);
    if (!cat) return redirect(ctx.res, `/buget/${an}`);
    const b = ctx.body || {};

    if (b.actiune === "imparte") {
      const peLuna = Math.round((suma(b.imparte) / 12) * 100) / 100;
      for (let l = 1; l <= 12; l++) await scrieValoare(an, cat.id, null, l, peLuna);
      return redirect(ctx.res, `/buget/${an}/categorie/${cat.id}`);
    }

    for (const cheie of Object.keys(b)) {
      if (!cheie.startsWith("v_")) continue;
      const bucati = cheie.slice(2).split("_");
      const luna = parseInt(bucati.pop(), 10);
      const cont = bucati.join("_");
      if (!luna || luna < 1 || luna > 12) continue;
      const brut = String(b[cheie] == null ? "" : b[cheie]).trim();
      const contReal = cont === "" ? null : cont;
      if (contReal !== null && !cat.conturi.includes(contReal)) continue;
      // Gol înseamnă „n-am scris nimic aici", nu zero: rândul dispare, iar
      // nivelul de deasupra redevine cel care contează.
      if (brut === "") await stergeValoare(an, cat.id, contReal, luna);
      else await scrieValoare(an, cat.id, contReal, luna, suma(brut));
    }
    redirect(ctx.res, `/buget/${an}/categorie/${cat.id}`);
  });

  router.post("/buget/:an/salveaza", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    const b = ctx.body || {};

    // „scoate" vine dintr-un buton din tabel: scoate un cont din categoria lui
    // și îl lasă neacoperit, ca să-l poți pune în alta.
    if (b.scoate) {
      await db
        .prepare(
          `DELETE FROM buget_conturi WHERE cont = ? AND categorie_id IN (SELECT id FROM buget_categorii WHERE an = ?)`
        )
        .run(String(b.scoate), an);
      return redirect(ctx.res, `/buget/${an}`);
    }

    if (b.prepopuleaza === "1") {
      // Creșterea se aplică la fiecare linie, nu la total: altfel n-ar mai fi
      // un punct de plecare pe care să-l poți corecta rând cu rând.
      const procentCrestere = suma(b.crestere);
      const factor = 1 + procentCrestere / 100;
      const d = await tabloul(an);
      for (const r of d.venituri.concat(d.cheltuieli))
        await db
          .prepare("UPDATE buget_categorii SET bugetat = ? WHERE id = ?")
          .run(Math.round(r.ante1Anualizat * factor * 100) / 100, r.id);
      // Prepopularea atinge DOAR cifra anuală. Ce ai scris pe luni sau pe
      // subconturi rămâne — și rămâne și mai tare decât ea, cum scrie regula.
      return redirect(ctx.res, `/buget/${an}?prepopulat=1`);
    }

    let scrise = 0;
    for (const cheie of Object.keys(b)) {
      if (!cheie.startsWith("b_")) continue;
      const id = parseInt(cheie.slice(2), 10);
      if (!id) continue;
      await db
        .prepare("UPDATE buget_categorii SET bugetat = ? WHERE id = ? AND an = ?")
        .run(suma(b[cheie]), id, an);
      scrise++;
    }
    redirect(ctx.res, `/buget/${an}?salvate=${scrise}`);
  });

  // Mută un cont într-o categorie. Se scoate întâi din oriunde ar fi fost în
  // anul ăsta: un cont în două categorii ar fi numărat de două ori.
  router.post("/buget/:an/muta", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    const b = ctx.body || {};
    const cont = String(b.cont || "").trim();
    const catId = parseInt(b.categorie_id, 10);
    if (!cont || !catId) return redirect(ctx.res, `/buget/${an}`);
    const cat = await db.prepare("SELECT id FROM buget_categorii WHERE id = ? AND an = ?").get(catId, an);
    if (!cat) return redirect(ctx.res, `/buget/${an}`);
    await db
      .prepare(
        `DELETE FROM buget_conturi WHERE cont = ? AND categorie_id IN (SELECT id FROM buget_categorii WHERE an = ?)`
      )
      .run(cont, an);
    await db
      .prepare("INSERT INTO buget_conturi (categorie_id, cont) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(catId, cont);
    redirect(ctx.res, `/buget/${an}`);
  });

  router.post("/buget/:an/categorie", async (ctx) => {
    if (!eAdmin(ctx.user)) return send(ctx.res, 403, "Doar administratorul.");
    const an = parseInt(ctx.params.an, 10);
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    const fel = b.fel === "venit" ? "venit" : "cheltuiala";
    if (nume) await db.prepare("INSERT INTO buget_categorii (an, fel, nume, ordine) VALUES (?, ?, ?, 900)").run(an, fel, nume);
    redirect(ctx.res, `/buget/${an}`);
  });
}

module.exports = {
  register,
  tabloul,
  rulajul,
  realizatLunar,
  valorileBuget,
  bugetLuna,
  LUNI,
  categoriile,
  categoriaImplicita,
  felulContului,
  realizatPeCont,
  balantaAnului,
  snapshoturileAnului,
  luniAcoperite,
  suma,
  seamanaAn,
  AN_IMPLICIT,
};
