"use strict";
// Forecast de aprovizionare: ce e de comandat ca să fie mereu stoc.
//
// CE A CERUT VALI, 11.11.2026:
//   „Vreau o pagină de forecast cu produse de comandat astfel încât să am stoc
//    mereu, bazat pe istoric vânzări și comenzi în curs, care ar trebui, în
//    funcție de rețete, să calculeze stocul consumat. Fă-o ca pe o pagină
//    distinctă în Procurement."
//
// SOCOTEALA, pe scurt. Pentru fiecare lucru pe care îl CUMPĂRĂM (materie primă
// și marfă de revânzare — adică tot ce n-are rețetă):
//
//   de comandat = ce cer comenzile în curs
//               + ce s-ar consuma în zilele de acoperire, în ritmul din istoric
//               − ce e pe stoc
//               − ce e pe drum de la furnizori
//
// CUM AJUNGE CEREREA LA MATERIA PRIMĂ. Vânzările și comenzile sunt pe produse
// finite; materia primă se deduce din rețete, nivel cu nivel (o pungă se face
// din folie, folia din granulă). La fiecare nivel se scade întâi ce există
// deja: dacă avem pungile făcute, nu mai trebuie folie pentru ele. Deci:
//
//   de făcut dintr-un produs = cererea lui − stocul lui − ce e deja în producție
//   materia primă cerută     = de făcut × cantitatea din rețetă
//
// Liniile de regie din rețete (salarii, energie, transport) nu sunt marfă și
// nu intră (lib/regie.js), ca la costul din rețetă.
//
// CE ÎNSEAMNĂ „COMENZI ÎN CURS":
//   • comenzile clienților nelivrate: cât a rămas de dat din fiecare (cantitatea
//     minus ce a ieșit deja din CT-Park pe comandă sau s-a facturat parțial);
//   • comenzile de producție care n-au comandă de client în ERP (registrul de
//     producție are comenzi scrise direct acolo — Sameday și alții). Pe același
//     client și același produs, comanda lui și producția lui sunt de regulă
//     aceeași marfă: se ia cea mai mare dintre ele, nu suma (aceeași regulă ca
//     la „Promis" din Stoc la zi).
//
// PRODUCȚIA. O comandă de producție începută se socotește că și-a luat deja
// materia primă din depozit: produsul ei e „pe drum", nu mai cere nimic. Una
// neîncepută („nouă") încă are de luat materia primă — și o va lua, orice ar
// spune vânzările: de-aia „de făcut" nu coboară sub ce e deja planificat.
//
// COMENZILE ÎN CURS SE ADUNĂ LA CONSUMUL DIN ISTORIC, nu se scad din el: după
// ce pleacă tot ce e comandat acum, trebuie să mai rămână stoc pentru zilele
// de acoperire alese. E varianta prudentă („să am stoc mereu").
//
// UNITĂȚILE. Vânzările sunt în unitatea produsului, rețetele în unitatea
// componentei. Stocul din CT-Park scris în altă unitate decât a produsului (un
// produs la kg cu paleți numărați în role) nu se poate compara cu consumul:
// nu intră în socoteală și rândul o spune.
//
// Socoteala e într-o funcție fără bază de date (`calculeaza`), ca s-o poată
// verifica un test cu numere știute. `citeste` doar aduce rândurile.

const db = require("./db");
const REG = require("./regie");
const SP = require("./stoc-produse");
const COST = require("./cost");

const EPS = 0.0005;
// Cât de departe se caută ziua în care se termină stocul.
const ZILE_CAUTARE = 365;
const FERESTRE = [90, 180, 365];
const ACOPERIRI = [15, 30, 45, 60, 90];
const FEREASTRA_IMPLICITA = 90;
const ACOPERIRE_IMPLICITA = 30;

const nr = (v) => Number(v) || 0;
const rot = (v) => Math.round(nr(v) * 1000) / 1000;

// „2026-11-11" + 30 → „2026-12-11". Zilele se adună în UTC, ca o zi cu schimbare
// de oră să nu mute data.
function ziPlus(zi, cate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(zi || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Math.round(nr(cate))));
  return d.toISOString().slice(0, 10);
}
const aziRo = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 10);

// Cantitatea de comandat, rotunjită în sus: nu se comandă 1.234,567 kg. Peste
// 100 la întreg, între 10 și 100 la o zecimală, sub 10 la două.
function rotunjitInSus(q) {
  const x = nr(q);
  if (!(x > EPS)) return 0;
  const pas = x >= 100 ? 1 : x >= 10 ? 0.1 : 0.01;
  return Math.round(Math.ceil(x / pas - 1e-9) * pas * 100) / 100;
}

// ---------------------------------------------------------------- socoteala
//
// d = {
//   azi,                       „2026-11-11"
//   produse:  [{ id, denumire, cod, unitate_masura, categorie, gestiune, categorie_depozit, activ }],
//   retete:   [{ produs_id, componenta_id, cantitate }]      — pe o unitate de produs
//   reper:    Map produs_id → { mediu }                      — prețul mediu facturat (lib/cost.js)
//             (produsele pot avea și cost_reteta, pret_vanzare — pentru rețetele scrise pe lot)
//   vanzari:  [{ produs_id, cantitate, luni, ultima }]       — în fereastra de istoric
//   comenzi:  [{ comanda_id, numar, partener_id, client, produs_id, cantitate, cantitate_livrata }]
//   iesite:   [{ comanda_id, produs_id, cantitate }]         — ieșit din CT-Park pe comenzi
//   stoc:     rândurile din lib/stoc-produse.js (stoc, um, alteUm, intrari, furnizori)
//   furnizori: Map produs_id → { furnizor_id, furnizor, pret_unitar, moneda, data }
// }
// opt = { zile, fereastra, toate }
function calculeaza(d, opt) {
  const o = d || {};
  const zile = ACOPERIRI.includes(Number(opt && opt.zile)) ? Number(opt.zile) : ACOPERIRE_IMPLICITA;
  const fereastra = FERESTRE.includes(Number(opt && opt.fereastra)) ? Number(opt.fereastra) : FEREASTRA_IMPLICITA;
  const toate = Boolean(opt && opt.toate);
  const azi = /^\d{4}-\d{2}-\d{2}$/.test(String(o.azi || "")) ? String(o.azi) : aziRo();

  const P = new Map();
  for (const p of o.produse || []) if (Number(p.id)) P.set(Number(p.id), p);
  // Un produs unit în altul („Unificarea codurilor") se socotește pe cel
  // păstrat: rețeta, vânzarea sau comanda scrisă pe codul vechi e a celui nou.
  const pastrat = (id) => {
    let x = Number(id) || 0;
    for (let pas = 0; pas < 8; pas++) {
      const p = P.get(x);
      const spre = p ? Number(p.fuzionat_in) || 0 : 0;
      if (!spre || spre === x || !P.has(spre)) break;
      x = spre;
    }
    return x;
  };
  // Scos din catalog: rămâne în socoteală (istoricul e istoric), dar rândul o spune.
  const inactiv = (id) => {
    const p = P.get(id);
    return Boolean(p) && Number(p.activ == null ? 1 : p.activ) !== 1;
  };
  const umDe = (id) => SP.normUm(P.has(id) ? P.get(id).unitate_masura : "");

  // Rețetele, doar cu marfă. O componentă scrisă de două ori se adună.
  const comp = new Map();
  const eComponenta = new Set();
  for (const r of o.retete || []) {
    const parinte = pastrat(r.produs_id);
    const c = pastrat(r.componenta_id);
    const q = nr(r.cantitate);
    if (!P.has(parinte) || !P.has(c) || parinte === c || !(q > 0)) continue;
    if (REG.eRegie(P.get(c).denumire)) continue;
    if (!comp.has(parinte)) comp.set(parinte, new Map());
    const m = comp.get(parinte);
    m.set(c, (m.get(c) || 0) + q);
    eComponenta.add(c);
  }
  const eFacut = (x) => comp.has(x);

  // REȚETELE SCRISE PE LOT, NU PE BUCATĂ. Aceeași judecată ca pe pagina
  // rețetei (lib/cost.js → verdictReteta): un cost de rețetă de peste trei ori
  // prețul cu care se vinde produsul înseamnă aproape sigur o rețetă pe 1.000
  // sau pe 1.500 de bucăți citită ca pe una. Înmulțită cu vânzările, cere de
  // o mie de ori mai multă materie primă: pe 11.11.2026, la prima deschidere
  // a paginii pe datele reale, „Sac Blue PE 860*1000” avea 125 kg de folie
  // „pe sac” și scotea singur 958 de tone de granulă de comandat.
  // Produsul rămâne la „de făcut”, dar rețeta lui NU se desface în materie
  // primă, iar pagina spune care sunt, ca să fie reparate — nu ca să se
  // comande după ele.
  const peLot = new Map();
  for (const x of comp.keys()) {
    const p = P.get(x);
    const ref = COST.pretReperProdus(o.reper, x, p.pret_vanzare, 0);
    if (COST.verdictReteta(p.cost_reteta, ref.pret).cheie !== "prea_mare") continue;
    peLot.set(x, { cost: Number(p.cost_reteta), pret: ref.pret, sursa: ref.sursa });
  }

  // Vânzările din istoric, pe zi.
  const rata = new Map();
  const vandut = new Map();
  for (const v of o.vanzari || []) {
    const id = pastrat(v.produs_id);
    if (!P.has(id)) continue;
    const inainte = vandut.get(id) || { cantitate: 0, luni: 0, ultima: "" };
    const ultima = String(v.ultima || "").slice(0, 10);
    vandut.set(id, { cantitate: inainte.cantitate + nr(v.cantitate), luni: Math.max(inainte.luni, Number(v.luni) || 0), ultima: ultima > inainte.ultima ? ultima : inainte.ultima });
  }
  // Stornările scad; un produs cu mai mult stornat decât vândut n-are consum.
  for (const [id, v] of [...vandut]) {
    if (v.cantitate > EPS) rata.set(id, v.cantitate / fereastra);
    else vandut.delete(id);
  }

  // Stocul și ce e pe drum, în unitatea produsului.
  const stoc = new Map();
  const stocAlteUm = new Map();
  const vine = new Map();
  const vineDoc = new Map();
  const inceput = new Map();
  const neinceput = new Map();
  const furnizoriStoc = new Map();
  // Cererea din producția fără comandă de client, pe client.
  const cerere = new Map(); // produs → Map(client → { comenzi, productie, documente })
  const cerereDe = (id, cheie) => {
    if (!cerere.has(id)) cerere.set(id, new Map());
    const m = cerere.get(id);
    if (!m.has(cheie)) m.set(cheie, { comenzi: 0, productie: 0, documente: [] });
    return m.get(cheie);
  };
  let productiiSocotite = 0;
  let stocFaraProdus = 0;
  for (const s of o.stoc || []) {
    const id = pastrat(s.produs_id);
    // Marfa scrisă liber pe palet, fără produs din catalog, nu se poate lega de
    // nicio rețetă și de nicio vânzare.
    if (!id || !P.has(id)) {
      if (nr(s.stoc) > EPS) stocFaraProdus++;
      continue;
    }
    const um = umDe(id);
    const potrivit = (u) => !um || !u || SP.normUm(u) === um;
    let q = 0;
    const altele = [];
    if (nr(s.stoc) > EPS) {
      if (potrivit(s.um)) q += nr(s.stoc);
      else altele.push({ um: s.um, cantitate: rot(s.stoc) });
    }
    for (const a of s.alteUm || []) {
      if (!(nr(a.cantitate) > EPS)) continue;
      if (potrivit(a.um)) q += nr(a.cantitate);
      else altele.push({ um: a.um, cantitate: rot(a.cantitate) });
    }
    if (q > EPS) stoc.set(id, (stoc.get(id) || 0) + q);
    if (altele.length) stocAlteUm.set(id, (stocAlteUm.get(id) || []).concat(altele));
    if (Array.isArray(s.furnizori) && s.furnizori.length) furnizoriStoc.set(id, s.furnizori.slice(0, 3));
    for (const i of s.intrari || []) {
      const cat = nr(i.cantitate);
      if (!(cat > EPS) || !potrivit(i.um)) continue;
      if (i.fel === "furnizor") {
        vine.set(id, (vine.get(id) || 0) + cat);
        if (!vineDoc.has(id)) vineDoc.set(id, []);
        vineDoc.get(id).push({ document: i.document || "", document_id: i.document_id || null, cantitate: rot(cat), data: String(i.data || ""), furnizor: i.furnizor || "" });
      } else if (i.fel === "productie") {
        productiiSocotite++;
        if (String(i.stare || "") === "noua") neinceput.set(id, (neinceput.get(id) || 0) + cat);
        else inceput.set(id, (inceput.get(id) || 0) + cat);
        // Producția făcută pentru un client, fără comanda lui în ERP, e ea
        // însăși cererea. Cea fără client e pentru stoc: nu cere nimic în plus,
        // doar acoperă (începută) sau e de făcut oricum (neîncepută).
        if (!Number(i.comanda_id) && i.cheieClient) {
          const c = cerereDe(id, i.cheieClient);
          c.productie += cat;
          c.documente.push({ fel: "productie", document: i.document || "", client: i.client || "", cantitate: rot(cat) });
        }
      }
    }
  }

  // Comenzile clienților: cât a rămas de dat.
  const iesit = new Map();
  for (const x of o.iesite || []) {
    const k = Number(x.comanda_id) + ":" + pastrat(x.produs_id);
    iesit.set(k, (iesit.get(k) || 0) + nr(x.cantitate));
  }
  const peComanda = new Map();
  for (const c of o.comenzi || []) {
    const id = pastrat(c.produs_id);
    if (!id || !Number(c.comanda_id) || !P.has(id)) continue;
    const k = Number(c.comanda_id) + ":" + id;
    if (!peComanda.has(k)) peComanda.set(k, { id, comanda_id: Number(c.comanda_id), numar: c.numar || "#" + c.comanda_id, client: c.client || "", cheie: SP.cheieClient(c.partener_id, c.client), cantitate: 0, livrat: 0 });
    const x = peComanda.get(k);
    x.cantitate += nr(c.cantitate);
    x.livrat += nr(c.cantitate_livrata);
  }
  const comenziSocotite = new Set();
  for (const [k, x] of peComanda) {
    // Ce a plecat: ieșit din CT-Park pe comandă sau facturat parțial — cea mai
    // mare dintre ele, fiindcă de regulă e aceeași marfă.
    const rest = x.cantitate - Math.max(iesit.get(k) || 0, x.livrat);
    if (!(rest > EPS)) continue;
    const c = cerereDe(x.id, x.cheie || "comanda:" + x.comanda_id);
    c.comenzi += rest;
    c.documente.push({ fel: "comanda", document: x.numar, document_id: x.comanda_id, client: x.client, cantitate: rot(rest) });
    comenziSocotite.add(x.comanda_id);
  }
  const inCurs = new Map();
  const inCursDoc = new Map();
  for (const [id, peClient] of cerere) {
    let total = 0;
    const doc = [];
    for (const c of peClient.values()) {
      total += Math.max(c.comenzi, c.productie);
      for (const x of c.documente) doc.push(x);
    }
    if (total > EPS) {
      inCurs.set(id, total);
      inCursDoc.set(id, doc);
    }
  }

  // Ordinea de socotit: întâi produsul, apoi din ce se face. O rețetă care se
  // învârte în cerc (A din B, B din A) e o greșeală de date: muchia care ar
  // închide cercul se sare și se raportează.
  const ordine = [];
  const stare = new Map();
  (function ordoneaza() {
    const radacini = new Set([...comp.keys(), ...rata.keys(), ...inCurs.keys(), ...neinceput.keys()]);
    for (const start of radacini) {
      if (stare.get(start)) continue;
      // Parcurgere în adâncime fără recursie: rețetele pot fi lungi.
      const stiva = [[start, [...(comp.get(start) || new Map()).keys()], 0]];
      stare.set(start, 1);
      while (stiva.length) {
        const sus = stiva[stiva.length - 1];
        const [x, copii] = sus;
        if (sus[2] < copii.length) {
          const c = copii[sus[2]++];
          if (!stare.get(c)) {
            stare.set(c, 1);
            stiva.push([c, [...(comp.get(c) || new Map()).keys()], 0]);
          }
        } else {
          stare.set(x, 2);
          ordine.push(x);
          stiva.pop();
        }
      }
    }
    ordine.reverse();
  })();
  const pozitie = new Map(ordine.map((x, i) => [x, i]));
  const cercuri = [];
  for (const [parinte, m] of comp) {
    for (const c of m.keys()) {
      if (pozitie.get(c) <= pozitie.get(parinte)) cercuri.push({ produs: P.get(parinte).denumire, componenta: P.get(c).denumire });
    }
  }

  // O trecere prin toate produsele, pentru un număr de zile de acoperire.
  //   cuStoc = false → cererea brută din istoric, fără stocuri și fără comenzi
  //   în curs: „cât consumă vânzările", de arătat ca atare.
  function trece(T, cuStoc, cuUrme) {
    const derivat = new Map();
    const brut = new Map();
    const deFacut = new Map();
    const urme = cuUrme ? new Map() : null;
    for (const x of ordine) {
      const direct = (cuStoc ? inCurs.get(x) || 0 : 0) + (rata.get(x) || 0) * T;
      const b = direct + (derivat.get(x) || 0);
      const planificat = cuStoc ? neinceput.get(x) || 0 : 0;
      if (!(b > EPS) && !(planificat > EPS)) continue;
      brut.set(x, b);
      if (!eFacut(x)) continue;
      const acoperit = cuStoc ? (stoc.get(x) || 0) + (inceput.get(x) || 0) + (vine.get(x) || 0) : 0;
      const f = Math.max(Math.max(0, b - acoperit), planificat);
      if (!(f > EPS)) continue;
      deFacut.set(x, f);
      if (peLot.has(x)) continue; // rețetă pe lot: cantitățile ei nu se pot folosi
      for (const [c, q] of comp.get(x)) {
        if (pozitie.get(c) <= pozitie.get(x)) continue; // cerc în rețetă
        derivat.set(c, (derivat.get(c) || 0) + f * q);
        if (urme) {
          if (!urme.has(c)) urme.set(c, []);
          urme.get(c).push({ produs_id: x, cantitate: f * q });
        }
      }
    }
    return { brut, deFacut, urme };
  }

  const acum = trece(0, true, false);
  const laTinta = trece(zile, true, true);
  const consumLunar = trece(30, false, false);

  // Marfa: ce are rost să apară într-o listă de comandat. Un articol vândut,
  // fără rețetă, fără categorie și fără gestiune, care n-a stat niciodată în
  // depozit și nu intră în nicio rețetă e, de regulă, un serviciu.
  const eMarfa = (id) => {
    const p = P.get(id);
    if (!p || REG.eRegie(p.denumire)) return false;
    return Boolean(
      String(p.categorie || "").trim() || String(p.gestiune || "").trim() || String(p.categorie_depozit || "").trim() ||
        eComponenta.has(id) || stoc.has(id) || stocAlteUm.has(id) || vine.has(id)
    );
  };

  // Ziua în care se termină stocul fiecărui lucru cumpărat: prima zi în care
  // cererea adunată trece de ce avem. Cererea crește cu zilele, deci se caută
  // cu înjumătățire, o trecere pe pas.
  const cumparate = ordine.filter((x) => !eFacut(x) && ((laTinta.brut.get(x) || 0) > EPS || (consumLunar.brut.get(x) || 0) > EPS));
  const treceri = new Map([[0, acum]]);
  const laZiua = (T) => {
    if (!treceri.has(T)) treceri.set(T, trece(T, true, false));
    return treceri.get(T);
  };
  // Prima zi T (0…ZILE_CAUTARE) cu brut(T) > prag; null dacă stocul ține tot anul.
  function primaZiPeste(x, prag) {
    if ((laZiua(0).brut.get(x) || 0) > prag + EPS) return 0;
    if (!((laZiua(ZILE_CAUTARE).brut.get(x) || 0) > prag + EPS)) return null;
    let jos = 0;
    let sus = ZILE_CAUTARE;
    while (sus - jos > 1) {
      const mij = Math.floor((jos + sus) / 2);
      if ((laZiua(mij).brut.get(x) || 0) > prag + EPS) sus = mij;
      else jos = mij;
    }
    return sus;
  }

  const numeDe = (id) => (P.has(id) ? P.get(id).denumire : "#" + id);
  const deCumparat = [];
  let faraIncadrare = 0;
  let cuAltaUnitate = 0;
  for (const x of cumparate) {
    if (!eMarfa(x)) {
      faraIncadrare++;
      if (!toate) continue;
    }
    const p = P.get(x);
    const s = stoc.get(x) || 0;
    const v = vine.get(x) || 0;
    const cereAcum = acum.brut.get(x) || 0;
    const necesar = laTinta.brut.get(x) || 0;
    const lipsa = Math.max(0, necesar - s - v);
    // Fără stoc deloc: nu „ajunge până mâine", nu ajunge.
    const zStoc = s > EPS ? primaZiPeste(x, s) : 0;
    const zDrum = v > EPS ? primaZiPeste(x, s + v) : zStoc;
    const urme = (laTinta.urme.get(x) || []).slice().sort((a, b) => b.cantitate - a.cantitate);
    const dinCe = urme.slice(0, 3).map((u) => ({ produs_id: u.produs_id, denumire: numeDe(u.produs_id), cantitate: rot(u.cantitate), parte: necesar > EPS ? u.cantitate / necesar : 0 }));
    const direct = (inCurs.get(x) || 0) + (rata.get(x) || 0) * zile;
    const doc = (vineDoc.get(x) || []).slice().sort((a, b) => (a.data || "9999").localeCompare(b.data || "9999"));
    const altaUm = stocAlteUm.get(x) || [];
    if (altaUm.length) cuAltaUnitate++;
    const uf = o.furnizori instanceof Map ? o.furnizori.get(x) : null;
    const scos = inactiv(x);
    let stareRand;
    if (cereAcum > s + v + EPS) stareRand = "lipsa";
    else if (cereAcum > s + EPS) stareRand = "pe_drum";
    else if (lipsa > EPS) stareRand = "de_comandat";
    else stareRand = "acoperit";
    deCumparat.push({
      produs_id: x,
      denumire: p.denumire,
      cod: p.cod || "",
      um: umDe(x) || String(p.unitate_masura || "").trim(),
      categorie: String(p.categorie || "").trim(),
      gestiune: String(p.gestiune || "").trim(),
      tip: String(p.categorie_depozit || "").trim(),
      marfa: eMarfa(x),
      inactiv: scos,
      consumLuna: rot(consumLunar.brut.get(x) || 0),
      inCurs: rot(cereAcum),
      stoc: rot(s),
      stocAlteUm: altaUm,
      vine: rot(v),
      vineData: (doc.find((y) => y.data) || {}).data || "",
      vineDocumente: doc,
      necesar: rot(necesar),
      deComandat: rotunjitInSus(lipsa),
      lipsaAcum: rot(Math.max(0, cereAcum - s - v)),
      zileStoc: zStoc,
      zileCuDrum: zDrum,
      dataStoc: zStoc == null ? "" : ziPlus(azi, zStoc),
      dataCuDrum: zDrum == null ? "" : ziPlus(azi, zDrum),
      dinCe,
      // Ce din necesar vine din vânzarea sau comanda produsului însuși (marfa
      // de revânzare, materia primă vândută ca atare).
      direct: rot(direct),
      vandut: vandut.get(x) || null,
      documente: inCursDoc.get(x) || [],
      furnizor: uf ? { id: Number(uf.furnizor_id) || null, nume: uf.furnizor || "", pret: uf.pret_unitar == null ? null : nr(uf.pret_unitar), moneda: uf.moneda || "", data: String(uf.data || "").slice(0, 10) } : null,
      furnizoriStoc: furnizoriStoc.get(x) || [],
      stare: stareRand,
    });
  }
  const rang = { lipsa: 0, pe_drum: 1, de_comandat: 2, acoperit: 3 };
  deCumparat.sort(
    (a, b) =>
      rang[a.stare] - rang[b.stare] ||
      (a.zileCuDrum == null ? 9999 : a.zileCuDrum) - (b.zileCuDrum == null ? 9999 : b.zileCuDrum) ||
      b.deComandat - a.deComandat ||
      a.denumire.localeCompare(b.denumire, "ro")
  );

  // Ce e de făcut în casă, ca să se vadă de unde vine cererea de materie primă.
  const deProdus = [];
  for (const [x, f] of laTinta.deFacut) {
    const p = P.get(x);
    deProdus.push({
      produs_id: x,
      denumire: p.denumire,
      cod: p.cod || "",
      um: umDe(x) || String(p.unitate_masura || "").trim(),
      consumLuna: rot(consumLunar.brut.get(x) || 0),
      inCurs: rot(inCurs.get(x) || 0),
      stoc: rot(stoc.get(x) || 0),
      inProductie: rot(inceput.get(x) || 0),
      neinceput: rot(neinceput.get(x) || 0),
      necesar: rot(laTinta.brut.get(x) || 0),
      deFacut: rot(f),
      inactiv: inactiv(x),
      retetaPeLot: peLot.has(x),
      documente: inCursDoc.get(x) || [],
    });
  }
  // Rețetele pe lot care chiar au ce cere: cele fără nimic de făcut nu
  // schimbă nimic și n-au de ce să sperie.
  const retetePeLot = [...peLot.entries()]
    .filter(([x]) => (laTinta.deFacut.get(x) || 0) > EPS || (consumLunar.deFacut.get(x) || 0) > EPS)
    .map(([x, v]) => ({
      produs_id: x,
      denumire: P.get(x).denumire,
      cod: P.get(x).cod || "",
      um: umDe(x) || String(P.get(x).unitate_masura || "").trim(),
      cost: v.cost,
      pret: v.pret,
      sursa: v.sursa,
      ori: v.cost / v.pret,
      deFacut: rot(laTinta.deFacut.get(x) || 0),
    }))
    .sort((a, b) => b.ori - a.ori || a.denumire.localeCompare(b.denumire, "ro"));
  deProdus.sort((a, b) => b.deFacut - a.deFacut || a.denumire.localeCompare(b.denumire, "ro"));

  return {
    azi,
    zile,
    fereastra,
    deCumparat,
    deProdus,
    note: {
      faraIncadrare,
      cuAltaUnitate,
      stocFaraProdus,
      cercuri,
      retetePeLot,
      produseVandute: rata.size,
      cuReteta: [...rata.keys()].filter(eFacut).length,
      comenziClienti: comenziSocotite.size,
      productiiInCurs: productiiSocotite,
    },
  };
}

// ---------------------------------------------------------------- datele
async function citeste(opt) {
  // Ziua de azi vine prin exports, ca un test s-o poată fixa.
  const azi = (opt && opt.azi) || module.exports.aziRo();
  const fereastra = FERESTRE.includes(Number(opt && opt.fereastra)) ? Number(opt.fereastra) : FEREASTRA_IMPLICITA;
  const deLa = ziPlus(azi, -fereastra);

  const produse = await db
    .prepare(
      `SELECT id, denumire, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod, unitate_masura, categorie, gestiune, categorie_depozit,
              COALESCE(activ, 1) AS activ, fuzionat_in, cost_reteta, pret_vanzare
         FROM produse`
    )
    .all();
  const retete = await db.prepare("SELECT produs_id, componenta_id, cantitate FROM retete_componente").all().catch(() => []);

  // Vânzările din fereastră: facturile de vânzare, fără ciorne, anulate și
  // între firmele grupului. Stornările scad (cantitate negativă).
  const DIN_FACTURI = `FROM facturi_linii fl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata', 'ciorna')
          AND COALESCE(f.intercompany, 0) = 0
          AND SUBSTR(f.data_emiterii, 1, 10) > ? AND SUBSTR(f.data_emiterii, 1, 10) <= ?`;
  const vanzari = await db
    .prepare(
      `SELECT fl.produs_id, SUM(fl.cantitate) AS cantitate,
              COUNT(DISTINCT SUBSTR(f.data_emiterii, 1, 7)) AS luni,
              MAX(SUBSTR(f.data_emiterii, 1, 10)) AS ultima
         ${DIN_FACTURI} AND fl.produs_id IS NOT NULL
        GROUP BY fl.produs_id`
    )
    .all(deLa, azi);
  // Cât din ce s-a facturat e pe linii fără produs din catalog: vânzările alea
  // nu se pot desface în materie primă, deci forecastul le pierde.
  const acoperire = await db
    .prepare(
      `SELECT COUNT(*) AS linii, SUM(CASE WHEN fl.produs_id IS NULL THEN 1 ELSE 0 END) AS linii_fara,
              SUM(ABS(fl.cantitate * fl.pret_unitar)) AS valoare,
              SUM(CASE WHEN fl.produs_id IS NULL THEN ABS(fl.cantitate * fl.pret_unitar) ELSE 0 END) AS valoare_fara
         ${DIN_FACTURI}`
    )
    .get(deLa, azi)
    .catch(() => null);

  // Cu ce preț se vinde fiecare produs — reperul după care se vede o rețetă pe lot.
  const reper = await COST.preturiReper().catch(() => new Map());

  const stoc = await SP.citeste({ vedeTot: true });
  const { comenzi, iesite } = await SP.comenziDeschise();

  // Comenzile de producție în curs scrise doar ca text, fără produs din
  // catalog: nu au rețetă de urmat, deci nu intră — dar se spune câte sunt.
  const faraProdus = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM comenzi_productie cp
        WHERE cp.status IN ('noua', 'in_productie') AND cp.produs_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM comenzi_productie_linii l WHERE l.comanda_id = cp.id)`
    )
    .get()
    .catch(() => null);

  // De la cine s-a cumpărat ultima oară fiecare lucru și cu cât.
  const furnizori = new Map();
  for (const x of await db
    .prepare(
      `SELECT DISTINCT ON (l.produs_id)
              l.produs_id, l.pret_unitar, c.moneda, c.data, c.furnizor_id, COALESCE(p.nume, '') AS furnizor
         FROM comenzi_furnizor_linii l
         JOIN comenzi_furnizor c ON c.id = l.comanda_id
         LEFT JOIN parteneri p ON p.id = c.furnizor_id
        WHERE l.produs_id IS NOT NULL AND c.status NOT IN ('anulata', 'ciorna')
        ORDER BY l.produs_id, c.data DESC, c.id DESC`
    )
    .all()
    .catch(() => [])) {
    furnizori.set(Number(x.produs_id), x);
  }

  return {
    azi,
    produse,
    retete,
    reper,
    vanzari,
    comenzi,
    iesite,
    stoc,
    furnizori,
    acoperire: {
      linii: nr(acoperire && acoperire.linii),
      liniiFara: nr(acoperire && acoperire.linii_fara),
      valoare: nr(acoperire && acoperire.valoare),
      valoareFara: nr(acoperire && acoperire.valoare_fara),
    },
    productieFaraProdus: nr(faraProdus && faraProdus.n),
  };
}

async function forecast(opt) {
  const d = await citeste(opt);
  const r = calculeaza(d, opt);
  r.note.productieFaraProdus = d.productieFaraProdus;
  r.note.acoperire = d.acoperire;
  return r;
}

module.exports = { EPS, FERESTRE, ACOPERIRI, FEREASTRA_IMPLICITA, ACOPERIRE_IMPLICITA, ZILE_CAUTARE, aziRo, ziPlus, rotunjitInSus, calculeaza, citeste, forecast };
