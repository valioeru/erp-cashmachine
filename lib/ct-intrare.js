"use strict";
// Intrarea mărfii în CT-Park: din formular, în paleți așezați pe locuri.
//
// CE A CERUT VALI, 30.10.2026, în trei mesaje:
//   „La adaugă marfă nouă în depozit crapă, iar dacă aleg vizual unde să adaug
//    un produs nou nu reține la final locul unde să-l pun în raft; ar trebui în
//    pagina de adăugare să fie rândul, locul etc. deja completate — acum nu sunt
//    nici căsuțele pentru asta."
//   „Și buton la final: Adaugă marfă."
//   „La adaugă să putem alege clar locul, și ce și cât ocupă acolo."
//
// De-aia formularul e acum o listă de RÂNDURI, câte unul pe palet:
//   rând · nivel · câmp · poziție · câte locuri ocupă · câți paleți · cât pe palet
//
// Un rând cu locul complet (din hartă sau scris de mână) e un palet pus FIX
// acolo. Un rând fără loc e „caută-mi tu N locuri de lățimea asta", eventual
// într-un rând anume. Dacă toate rândurile au locul știut și toate locurile
// sunt libere, marfa se pune direct („Adaugă marfă") — nu mai e nimic de
// confirmat. Altfel se arată pagina de confirmare, cu ce n-a mers spus pe nume.
//
// Funcțiile de aici sunt pure: primesc ce a trimis formularul și locurile din
// bază, și întorc planul. Baza o atinge doar ruta.

const MAX_LATIME = 3;
const MAX_PALETI = 60;

function lista(v) {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

// „12,5" și „12.5" sunt același lucru; câmpul gol nu e zero, e „nescris".
function cifra(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function intreg(v) {
  const s = String(v === null || v === undefined ? "" : v).trim();
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

const intre = (x, a, b) => Math.min(b, Math.max(a, x));
const idsDin = (s) => String(s || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean);

// ---------------------------------------------------------------------------
// Rândurile formularului, aduse la aceeași formă.
//
// Formularul nou trimite câmpuri repetate: loc_ids[], loc_rand[], loc_nivel[],
// loc_camp[], loc_pozitie[], loc_latime[], loc_paleti[], loc_cantitate[] —
// același număr din fiecare, aliniate pe poziție. Forma veche (un singur
// palet-tip, „cantitate totală", „locuri_alese") e înțeleasă în continuare,
// ca o pagină rămasă deschisă de dinainte de schimbare să nu piardă marfa.
function randuriDinFormular(b) {
  const c = {
    ids: lista(b["loc_ids[]"]),
    rand: lista(b["loc_rand[]"]),
    nivel: lista(b["loc_nivel[]"]),
    camp: lista(b["loc_camp[]"]),
    pozitie: lista(b["loc_pozitie[]"]),
    latime: lista(b["loc_latime[]"]),
    paleti: lista(b["loc_paleti[]"]),
    cantitate: lista(b["loc_cantitate[]"]),
  };
  const n = Math.max(...Object.values(c).map((x) => x.length));
  if (n > 0) {
    const toate = [];
    for (let i = 0; i < n; i++) {
      const ids = idsDin(c.ids[i]);
      const r = {
        ids,
        randId: intreg(c.rand[i]),
        nivel: intreg(c.nivel[i]),
        camp: intreg(c.camp[i]),
        pozitie: intreg(c.pozitie[i]),
        latime: intre(intreg(c.latime[i]) || ids.length || 1, 1, MAX_LATIME),
        paleti: intre(intreg(c.paleti[i]) || 1, 1, MAX_PALETI),
        cantitate: cifra(c.cantitate[i]),
      };
      r.cuLoc = r.ids.length > 0 || r.nivel !== null || r.camp !== null || r.pozitie !== null;
      toate.push(r);
    }
    // Rândurile goale de tot (fără loc și fără cantitate) sunt cele adăugate
    // cu „+ încă un palet" și lăsate necompletate — nu sunt paleți. Dacă TOATE
    // sunt goale, primul rămâne: „un palet, caută-i tu loc" e o intrare validă.
    const pline = toate.filter((r) => r.cuLoc || r.cantitate !== null);
    const alese = pline.length ? pline : toate.slice(0, 1);
    return alese.map((r, i) => ({ ...r, index: i }));
  }

  // ---- forma veche ----
  const latime = intre(intreg(b.locuri) || 1, 1, MAX_LATIME);
  const paleti = intre(intreg(b.paleti) || 1, 1, MAX_PALETI);
  const total = cifra(b.cantitate);
  const randId = intreg(b.rand_id);
  const alese = idsDin(b.locuri_alese);
  if (alese.length) {
    // Locurile alese pe hartă, în forma veche: se grupează în paleți lați
    // abia când se știu pozițiile lor (în planifica), iar totalul se împarte
    // la câți paleți ies.
    return [{ index: 0, alese, latime, paleti: 1, randId, totalDeImpartit: total, cuLoc: true, ids: [] }];
  }
  const scrise = [b.loc_nivel, b.loc_camp, b.loc_pozitie].map(intreg);
  if (scrise.some((x) => x !== null)) {
    return [{ index: 0, ids: [], randId, nivel: scrise[0], camp: scrise[1], pozitie: scrise[2], latime, paleti: 1, cantitate: total, cuLoc: true }];
  }
  return [{ index: 0, ids: [], randId, nivel: null, camp: null, pozitie: null, latime, paleti, cantitate: total === null ? null : total / paleti, cuLoc: false }];
}

// ---------------------------------------------------------------------------
// Locurile alese pe hartă, strânse în paleți: pozițiile vecine din același
// rând, nivel și câmp fac un palet lat (cel mult `latimeMax` locuri), cele
// răzlețe fac paleți separați. Cu `separat`, fiecare loc e paletul lui.
function grupeazaLocuri(locuri, latimeMax, separat) {
  const sortate = (locuri || [])
    .filter(Boolean)
    .slice()
    .sort((x, y) => Number(x.rand_id) - Number(y.rand_id) || Number(x.nivel) - Number(y.nivel) || Number(x.camp) - Number(y.camp) || Number(x.pozitie) - Number(y.pozitie));
  const grupuri = [];
  let curent = [];
  for (const l of sortate) {
    const u = curent[curent.length - 1];
    const lipit =
      !separat && u && Number(u.rand_id) === Number(l.rand_id) && Number(u.nivel) === Number(l.nivel) && Number(u.camp) === Number(l.camp) &&
      Number(l.pozitie) === Number(u.pozitie) + 1 && curent.length < (latimeMax || MAX_LATIME);
    if (lipit) curent.push(l);
    else {
      if (curent.length) grupuri.push(curent);
      curent = [l];
    }
  }
  if (curent.length) grupuri.push(curent);
  return grupuri;
}

// ---------------------------------------------------------------------------
// Planul: ce palet merge pe ce locuri.
//
//   randuri  — din randuriDinFormular
//   locuri   — TOATE locurile din rândurile active, fiecare cu `ocupat` (0/1),
//              `blocat`, rand_id, rand_numar, rand_eticheta, nivel, camp,
//              pozitie, adresa, categorie
//   categorie — categoria mărfii, pentru preferința de zonă la propuneri
//
// Întoarce { paleti, erori, lipsa, directe }:
//   paleti — [{ index, locuri, cantitate, propus }]
//   erori  — [{ index, mesaj }]: un loc scris greșit, ocupat, inexistent
//   lipsa  — [{ index, ceruti, gasiti }]: n-au fost destule locuri libere
//   directe — true când totul era știut și liber: marfa se poate pune direct
function planifica(randuri, locuri, categorie) {
  const toate = (locuri || []).map((l) => ({ ...l, id: Number(l.id) }));
  const dupaId = new Map(toate.map((l) => [l.id, l]));
  const dupaCoord = new Map(toate.map((l) => [`${Number(l.rand_id)}|${Number(l.nivel)}|${Number(l.camp)}|${Number(l.pozitie)}`, l]));
  const folosite = new Set();
  const liber = (l) => l && !Number(l.ocupat) && !Number(l.blocat) && !folosite.has(l.id);
  const paleti = [];
  const erori = [];
  const lipsa = [];
  const deCautat = [];

  // 1. Rândurile cu locul știut. Trec primele: un loc ales de om are
  //    întâietate în fața unuia propus de ERP.
  for (const r of randuri) {
    let grupuri = null;
    if (r.alese && r.alese.length) {
      const gasite = r.alese.map((id) => dupaId.get(id));
      const lipsesc = r.alese.filter((id, i) => !gasite[i]);
      if (lipsesc.length) erori.push({ index: r.index, mesaj: `${lipsesc.length === 1 ? "Un loc ales nu mai există" : lipsesc.length + " locuri alese nu mai există"} pe hartă.` });
      grupuri = grupeazaLocuri(gasite.filter(Boolean), r.latime, false);
    } else if (r.ids && r.ids.length) {
      const gasite = r.ids.map((id) => dupaId.get(id));
      if (gasite.some((l) => !l)) {
        erori.push({ index: r.index, mesaj: "Un loc ales pe hartă nu mai există — alege din nou." });
        continue;
      }
      grupuri = [gasite];
    } else if (r.cuLoc) {
      if (!r.randId || r.nivel === null || r.camp === null || r.pozitie === null) {
        erori.push({ index: r.index, mesaj: "Pentru un loc anume completează toate patru: rândul, nivelul, câmpul și poziția." });
        continue;
      }
      if (r.paleti > 1) {
        erori.push({
          index: r.index,
          mesaj: `Pe un loc anume încape un singur palet, nu ${r.paleti}. Lasă locul gol ca să caute ERP-ul ${r.paleti} locuri, sau scrie câte un rând pe fiecare palet.`,
        });
        continue;
      }
      const g = [];
      for (let k = 0; k < r.latime; k++) {
        const l = dupaCoord.get(`${r.randId}|${r.nivel}|${r.camp}|${r.pozitie + k}`);
        if (!l) break;
        g.push(l);
      }
      if (g.length < r.latime) {
        erori.push({
          index: r.index,
          mesaj:
            r.latime > 1 && g.length
              ? `De la nivel ${r.nivel}, câmp ${r.camp}, poziția ${r.pozitie} nu sunt ${r.latime} locuri unul lângă altul.`
              : `În rândul ales nu există locul nivel ${r.nivel}, câmp ${r.camp}, poziție ${r.pozitie}.`,
        });
        continue;
      }
      grupuri = [g];
    } else {
      deCautat.push(r);
      continue;
    }

    const cantitate = r.totalDeImpartit !== undefined && r.totalDeImpartit !== null ? r.totalDeImpartit / Math.max(1, grupuri.length) : r.cantitate;
    for (const g of grupuri) {
      const nelibere = g.filter((l) => !liber(l));
      if (nelibere.length) {
        const dejaInFormular = nelibere.every((l) => folosite.has(l.id) && !Number(l.ocupat));
        erori.push({
          index: r.index,
          mesaj: dejaInFormular
            ? `Locul ${nelibere.map((l) => l.adresa).join(", ")} e trecut de două ori în formular.`
            : `Locul ${nelibere.map((l) => l.adresa).join(", ")} nu e liber${nelibere.some((l) => Number(l.blocat)) ? " (e scos din uz)" : " — cineva a pus marfă acolo între timp"}.`,
        });
        continue;
      }
      g.forEach((l) => folosite.add(l.id));
      paleti.push({ index: r.index, locuri: g, cantitate: cantitate === undefined ? null : cantitate, propus: false });
    }
  }

  // 2. Rândurile fără loc: ERP-ul caută grupuri de poziții libere lipite, în
  //    același câmp și nivel (un palet lat nu se rupe în două câmpuri).
  //    Potrivirea pe categorie e o preferință, nu o regulă.
  const scor = (g) => {
    const c = g[0].categorie;
    const potrivitZona = categorie && c === categorie ? 0 : !c ? 1 : 2;
    const potrivitRand = categorie && g[0].rand_eticheta === categorie ? 0 : 1;
    return potrivitZona * 10 + potrivitRand * 3 + Number(g[0].nivel || 0);
  };
  for (const r of deCautat) {
    const peCamp = new Map();
    for (const l of toate) {
      if (!liber(l)) continue;
      if (r.randId && Number(l.rand_id) !== r.randId) continue;
      const k = `${l.rand_id}|${l.nivel}|${l.camp}`;
      if (!peCamp.has(k)) peCamp.set(k, []);
      peCamp.get(k).push(l);
    }
    const grupuri = [];
    for (const [, ls] of peCamp) {
      ls.sort((x, y) => Number(x.pozitie) - Number(y.pozitie));
      for (let i = 0; i + r.latime <= ls.length; ) {
        const felie = ls.slice(i, i + r.latime);
        const lipite = felie.every((l, k) => k === 0 || Number(l.pozitie) === Number(felie[k - 1].pozitie) + 1);
        if (lipite) {
          grupuri.push(felie);
          i += r.latime;
        } else i += 1;
      }
    }
    grupuri.sort((a, b) => scor(a) - scor(b) || Number(a[0].rand_numar || 0) - Number(b[0].rand_numar || 0) || Number(a[0].camp) - Number(b[0].camp) || Number(a[0].pozitie) - Number(b[0].pozitie));
    const luate = grupuri.slice(0, r.paleti);
    for (const g of luate) {
      g.forEach((l) => folosite.add(l.id));
      paleti.push({ index: r.index, locuri: g, cantitate: r.cantitate, propus: true });
    }
    if (luate.length < r.paleti) lipsa.push({ index: r.index, ceruti: r.paleti, gasiti: luate.length, latime: r.latime });
  }

  const directe = paleti.length > 0 && !erori.length && !lipsa.length && paleti.every((p) => !p.propus);
  return { paleti, erori, lipsa, directe };
}

module.exports = { MAX_LATIME, MAX_PALETI, lista, cifra, intreg, randuriDinFormular, grupeazaLocuri, planifica };
