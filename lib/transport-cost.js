"use strict";
// Cat costa sa duci marfa de aici acolo, si cu cine.
//
// Trei lucruri pe care le-am invatat de la Vali si care schimba complet
// clasamentul, nu doar afisarea lui:
//
//   1. UN PALET LA TIMISOARA NU SE DUCE CU MASINA NOASTRA. Nu e mai ieftin
//      si nici mai repede. Palex are reteaua, duce paletul in 24-48h si
//      incaseaza cateva sute de lei; dubita noastra face 1100 km dus-intors,
//      arde motorina, tine soferul doua zile si ajunge mai tarziu. Deci
//      clasamentul trebuie sa arate ZILE langa LEI, iar termenul taie
//      inaintea pretului.
//
//   2. MASINA PROPRIE SE CONFIGUREAZA SI SE SOCOTESTE DUS-INTORS. Consum la
//      suta, pretul motorinei, uzura pe km, omul, diurna, taxele de drum. Un
//      vehicul neconfigurat NU costa zero — nu intra in clasament pana nu
//      i se scriu cifrele, altfel castiga mereu si pierzi bani la fiecare
//      cursa.
//
//   3. TRANSPORTUL INTERN SE REZERVA. Masina ocupata in ziua aia nu e o
//      optiune mai scumpa, e o optiune care nu exista. Se exclude, si se
//      spune pentru ce e luata — altfel cineva o aloca de doua ori si afla
//      dimineata, in rampa.
//
// Aici stau doar regulile. Tabelele si paginile le cheama.

const EPS = 0.001;

function nr(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

function cifra(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const x = Number(s);
  return isFinite(x) ? x : null;
}

function rotunjit(x) {
  return Math.round(nr(x) * 100) / 100;
}

// Numele de localitati vin scrise in cinci feluri: "Timisoara", "TIMISOARA",
// "Timișoara", "Timisoara, Timis", cu spatii in plus. Se compara pe forma
// curatata, altfel tariful pentru Timisoara nu se potriveste niciodata.
function cheie(text) {
  return String(text == null ? "" : text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șşŞȘ]/g, "s")
    .replace(/[țţŢȚ]/g, "t")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function esteData(s) {
  const t = String(s == null ? "" : s).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(t + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

function adaugaZile(data, n) {
  const d = new Date(String(data).slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(nr(n)));
  return d.toISOString().slice(0, 10);
}

function zile(de_la, pana_la) {
  const a = new Date(String(de_la).slice(0, 10) + "T00:00:00Z").getTime();
  const b = new Date(String(pana_la).slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

// Doua intervale de zile se suprapun? Folosit la rezervarile masinilor.
function seSuprapun(a1, a2, b1, b2) {
  const A1 = String(a1).slice(0, 10);
  const A2 = String(a2 || a1).slice(0, 10);
  const B1 = String(b1).slice(0, 10);
  const B2 = String(b2 || b1).slice(0, 10);
  return A1 <= B2 && B1 <= A2;
}

// ---------------------------------------------------------------------------
// TARIFUL EXTERN
// ---------------------------------------------------------------------------
//
// Un tarif de transport vine in patru forme si toate patru trebuie puse pe
// acelasi rand ca sa se poata compara:
//
//   cursa  — pret fix pe transport, indiferent de cat duci
//   palet  — lei/palet (asa lucreaza retelele de paletizare: Palex, Cargus)
//   kg     — lei/kg, de obicei pe transe de greutate
//   km     — lei/km (asa lucreaza camionul inchiriat)
//
// Peste pret vine, uneori, suprataxa de combustibil, in procente. Si sub el
// sta pretul minim pe cursa, care e motivul pentru care un colet de 2 kg la
// 400 km nu costa 2 lei.

const FELURI = ["cursa", "palet", "kg", "km"];

// Se potriveste randul asta de tarif cu expeditia?
// Intoarce { da: true, specificitate } sau { da: false, motiv }.
function potrivire(tarif, exp) {
  const t = tarif || {};
  const e = exp || {};

  if (t.fel && !FELURI.includes(t.fel)) return { da: false, motiv: "fel de tarif necunoscut: " + t.fel };

  let specificitate = 0;
  if (t.localitate) {
    if (cheie(t.localitate) !== cheie(e.localitate)) return { da: false, motiv: "alta localitate" };
    specificitate = 2;
  } else if (t.judet) {
    if (cheie(t.judet) !== cheie(e.judet)) return { da: false, motiv: "alt judet" };
    specificitate = 1;
  }

  const km = cifra(e.km);
  if (t.km_de_la != null && (km == null || km < nr(t.km_de_la) - EPS)) return { da: false, motiv: "sub transa de km" };
  if (t.km_pana_la != null && (km == null || km > nr(t.km_pana_la) + EPS)) return { da: false, motiv: "peste transa de km" };

  const kg = cifra(e.greutate_kg);
  if (t.greutate_de_la != null && (kg == null || kg < nr(t.greutate_de_la) - EPS)) return { da: false, motiv: "sub transa de greutate" };
  if (t.greutate_pana_la != null && (kg == null || kg > nr(t.greutate_pana_la) + EPS)) return { da: false, motiv: "peste transa de greutate" };

  const pal = cifra(e.paleti);
  if (t.paleti_de_la != null && (pal == null || pal < nr(t.paleti_de_la) - EPS)) return { da: false, motiv: "sub numarul de paleti" };
  if (t.paleti_pana_la != null && (pal == null || pal > nr(t.paleti_pana_la) + EPS)) return { da: false, motiv: "peste numarul de paleti" };

  // Datele de care are nevoie formula trebuie sa existe. Un tarif pe km fara
  // km nu da zero, da „nu stiu".
  if (t.fel === "km" && km == null) return { da: false, motiv: "tarif pe km, dar expeditia n-are kilometri" };
  if (t.fel === "kg" && kg == null) return { da: false, motiv: "tarif pe kg, dar expeditia n-are greutate" };
  if (t.fel === "palet" && pal == null) return { da: false, motiv: "tarif pe palet, dar expeditia n-are numar de paleti" };

  return { da: true, specificitate };
}

// Cat costa expeditia pe randul asta de tarif.
function costTarif(tarif, exp, oferta) {
  const t = tarif || {};
  const e = exp || {};
  const o = oferta || {};
  let baza = 0;
  let formula = "";
  if (t.fel === "cursa") {
    baza = nr(t.pret);
    formula = "preț fix pe cursă";
  } else if (t.fel === "palet") {
    baza = nr(t.pret) * nr(e.paleti);
    formula = `${nr(e.paleti)} paleți × ${rotunjit(t.pret)}`;
  } else if (t.fel === "kg") {
    baza = nr(t.pret) * nr(e.greutate_kg);
    formula = `${nr(e.greutate_kg)} kg × ${rotunjit(t.pret)}`;
  } else if (t.fel === "km") {
    baza = nr(t.pret) * nr(e.km);
    formula = `${nr(e.km)} km × ${rotunjit(t.pret)}`;
  }

  const supra = nr(o.suprataxa_combustibil_pct);
  const combustibil = supra > 0 ? baza * (supra / 100) : 0;
  let total = baza + combustibil;

  // Pretul minim e motivul pentru care un colet de 2 kg la 400 km nu costa
  // 2 lei. Se aplica DUPA suprataxa, cum scrie in contractele reale.
  const minim = nr(t.pret_minim);
  let aplicatMinim = false;
  if (minim > 0 && total < minim - EPS) {
    total = minim;
    aplicatMinim = true;
  }

  return {
    cost: rotunjit(total),
    detaliu: {
      baza: rotunjit(baza),
      formula,
      suprataxa_combustibil: rotunjit(combustibil),
      suprataxa_pct: supra || 0,
      pret_minim: minim || 0,
      aplicat_minim: aplicatMinim,
    },
  };
}

// ---------------------------------------------------------------------------
// MASINA NOASTRA
// ---------------------------------------------------------------------------
//
// Capcana numarul unu din toate ERP-urile care au un buton „transport
// propriu": se trece doar motorina dusa. Iese jumatate din pretul real si
// toata lumea se mira la final de luna unde s-au dus banii.
//
// Se socoteste DUS-INTORS, cu omul si cu diurna. Daca masina se intoarce cu
// marfa (retur platit de altcineva), se bifeaza si se pune doar dusul la
// cursa asta — dar e o alegere constienta, nu valoarea implicita.

const CAMPURI_MASINA = [
  ["consum_l_100km", "consumul la suta"],
  ["pret_carburant", "prețul carburantului"],
];

// Intoarce { cost, detaliu, zile } sau { eroare } daca masina nu e configurata.
function costIntern(vehicul, exp, optiuni) {
  const v = vehicul || {};
  const e = exp || {};
  const o = optiuni || {};

  // Un vehicul neconfigurat nu costa zero. Daca ar costa zero ar castiga
  // mereu, si fiecare cursa ar pierde bani fara ca nimeni sa vada de ce.
  const lipsa = CAMPURI_MASINA.filter(([c]) => !(nr(v[c]) > 0)).map(([, et]) => et);
  if (lipsa.length) {
    return { eroare: "Mașina „" + (v.nume || "fără nume") + "” n-are completat " + lipsa.join(" și ") + ". Până atunci nu intră în comparație." };
  }

  const km1 = cifra(e.km);
  if (km1 == null) return { eroare: "Nu știm câți kilometri sunt până la " + (e.localitate || "destinație") + ". Scrie distanța o dată și se ține minte." };

  // Dus-intors. Asta e linia care face diferenta intre un calcul corect si
  // unul care te costa bani la fiecare cursa.
  const returCuMarfa = !!o.retur_cu_marfa;
  const kmTotal = returCuMarfa ? km1 : km1 * 2;

  const combustibil = (kmTotal / 100) * nr(v.consum_l_100km) * nr(v.pret_carburant);
  const uzura = kmTotal * nr(v.cost_km_uzura);

  // Cat tine cursa. Viteza medie reala pe drumurile noastre, plus timpul de
  // incarcat si descarcat. Opt ore de condus pe zi — un sofer nu conduce 14.
  const viteza = nr(v.viteza_medie_kmh) > 0 ? nr(v.viteza_medie_kmh) : 60;
  const oreDrum = kmTotal / viteza;
  const oreManipulare = nr(v.ore_incarcare) > 0 ? nr(v.ore_incarcare) : 2;
  const oreTotal = oreDrum + oreManipulare;
  const oreMaxPeZi = nr(v.ore_max_zi) > 0 ? nr(v.ore_max_zi) : 9;
  const zileCursa = Math.max(1, Math.ceil(oreTotal / oreMaxPeZi));

  const sofer = nr(v.cost_ora_sofer) > 0 ? nr(v.cost_ora_sofer) * oreTotal : nr(v.cost_zi_sofer) * zileCursa;
  const diurna = nr(v.diurna_zi) * (zileCursa > 1 ? zileCursa : 0);
  const taxe = nr(v.taxe_cursa);

  const total = combustibil + uzura + sofer + diurna + taxe;

  return {
    cost: rotunjit(total),
    zile: zileCursa,
    detaliu: {
      km_dus: rotunjit(km1),
      km_total: rotunjit(kmTotal),
      retur_cu_marfa: returCuMarfa,
      combustibil: rotunjit(combustibil),
      uzura: rotunjit(uzura),
      sofer: rotunjit(sofer),
      diurna: rotunjit(diurna),
      taxe: rotunjit(taxe),
      ore: Math.round(oreTotal * 10) / 10,
      formula:
        `${rotunjit(kmTotal)} km ${returCuMarfa ? "(doar dus, retur cu marfă)" : "(dus-întors)"} · ` +
        `${nr(v.consum_l_100km)} l/100km × ${rotunjit(v.pret_carburant)} lei`,
    },
  };
}

// Masina e libera in zilele cursei?
// rezervari: [{ de_la, pana_la, ce }]
function estLiber(vehicul, de_la, pana_la) {
  const rez = (vehicul && vehicul.rezervari) || [];
  for (const r of rez) {
    if (r && r.stare === "anulata") continue;
    if (seSuprapun(de_la, pana_la, r.de_la, r.pana_la)) {
      return { liber: false, ocupat_de: r };
    }
  }
  return { liber: true };
}

// ---------------------------------------------------------------------------
// CLASAMENTUL
// ---------------------------------------------------------------------------
//
// Ordinea verificarilor nu e intamplatoare. Intai se taie ce NU POATE face
// cursa — nu incape, nu ajunge la timp, masina e luata, oferta a expirat.
// Abia pe ce ramane se compara pretul. „Cel mai ieftin care nu incape" nu e
// cel mai ieftin, e o cursa ratata descoperita in rampa.

function variantaExterna(transportator, exp, azi) {
  const t = transportator || {};
  const of = t.oferta || {};
  const nume = t.nume || "fără nume";

  if (of.valabil_de_la && azi && String(azi) < String(of.valabil_de_la)) {
    return { exclus: { nume, fel: "extern", motiv: "oferta intră în vigoare pe " + of.valabil_de_la } };
  }
  // O oferta expirata nu se foloseste in tacere. Pretul de anul trecut pus
  // intr-un clasament de azi e o minciuna cu doua zecimale.
  if (of.valabil_pana_la && azi && String(azi) > String(of.valabil_pana_la)) {
    return { exclus: { nume, fel: "extern", motiv: "oferta a expirat pe " + of.valabil_pana_la + " — cere tarif nou" } };
  }

  const candidati = [];
  // Un tarif care s-ar fi potrivit dar nu incape e cu totul altceva decat un
  // tarif care nu exista. „Palex n-are tarif pentru Timisoara" il trimite pe
  // om sa ceara o oferta pe care o are deja; „Palex ia 10 paleti, tu ai 12"
  // ii spune sa imparta marfa in doua curse.
  const nuIncap = [];
  for (const tarif of t.tarife || []) {
    const p = potrivire(tarif, exp);
    if (!p.da) continue;
    const capKg = cifra(tarif.capacitate_kg);
    const capPal = cifra(tarif.capacitate_paleti);
    if (capKg != null && nr(exp.greutate_kg) > capKg + EPS) {
      nuIncap.push(`ia ${capKg} kg, expediția are ${nr(exp.greutate_kg)} kg`);
      continue;
    }
    if (capPal != null && nr(exp.paleti) > capPal + EPS) {
      nuIncap.push(`ia ${capPal} paleți, expediția are ${nr(exp.paleti)}`);
      continue;
    }
    const c = costTarif(tarif, exp, of);
    candidati.push({ tarif, specificitate: p.specificitate, cost: c.cost, detaliu: c.detaliu });
  }

  if (!candidati.length) {
    return {
      exclus: {
        nume,
        fel: "extern",
        motiv: nuIncap.length
          ? nuIncap[0] + " — împarte marfa în două curse sau cere o ofertă pentru camion"
          : "nu are tarif pentru " + (exp.localitate || exp.judet || "destinația asta"),
      },
    };
  }

  // Tariful mai specific bate tariful general: un rand scris anume pentru
  // Timisoara e pretul negociat, randul „orice judet" e lista de pret.
  candidati.sort((a, b) => b.specificitate - a.specificitate || a.cost - b.cost);
  const ales = candidati[0];

  const zileLivrare = cifra(ales.tarif.zile_livrare);
  return {
    varianta: {
      transportator_id: t.id,
      nume,
      fel: "extern",
      oferta_id: of.id,
      tarif_id: ales.tarif.id,
      cost: ales.cost,
      moneda: of.moneda || "RON",
      zile: zileLivrare == null ? null : zileLivrare,
      detaliu: ales.detaliu,
      eticheta_tarif: etichetaTarif(ales.tarif),
    },
  };
}

function etichetaTarif(t) {
  const unde = t.localitate || t.judet || "orice destinație";
  const cum =
    t.fel === "palet" ? rotunjit(t.pret) + " lei/palet"
      : t.fel === "kg" ? rotunjit(t.pret) + " lei/kg"
        : t.fel === "km" ? rotunjit(t.pret) + " lei/km"
          : rotunjit(t.pret) + " lei/cursă";
  return unde + ": " + cum;
}

function variantaInterna(vehicul, exp, azi, optiuni) {
  const v = vehicul || {};
  const nume = v.nume || "mașina firmei";
  const c = costIntern(v, exp, optiuni);
  if (c.eroare) return { exclus: { nume, fel: "intern", motiv: c.eroare } };

  const capKg = cifra(v.capacitate_kg);
  const capPal = cifra(v.capacitate_paleti);
  if (capKg != null && nr(exp.greutate_kg) > capKg + EPS) {
    return { exclus: { nume, fel: "intern", motiv: `duce ${capKg} kg, expediția are ${nr(exp.greutate_kg)} kg` } };
  }
  if (capPal != null && nr(exp.paleti) > capPal + EPS) {
    return { exclus: { nume, fel: "intern", motiv: `intră ${capPal} paleți, expediția are ${nr(exp.paleti)}` } };
  }

  // Rezervarea. Masina luata in ziua aia nu e o optiune mai scumpa, e o
  // optiune care nu exista.
  const plecare = esteData(exp.data_ridicare) ? exp.data_ridicare : azi;
  if (esteData(plecare)) {
    const pana = adaugaZile(plecare, Math.max(0, c.zile - 1));
    const l = estLiber(v, plecare, pana);
    if (!l.liber) {
      const r = l.ocupat_de;
      return {
        exclus: {
          nume,
          fel: "intern",
          motiv: `rezervată ${r.de_la}${r.pana_la && r.pana_la !== r.de_la ? "–" + r.pana_la : ""}${r.ce ? " pentru " + r.ce : ""}`,
        },
      };
    }
  }

  return {
    varianta: {
      transportator_id: v.id,
      nume,
      fel: "intern",
      oferta_id: null,
      tarif_id: null,
      cost: c.cost,
      moneda: "RON",
      zile: c.zile,
      detaliu: c.detaliu,
      eticheta_tarif: c.detaliu.formula,
    },
  };
}

// optiuni: { externi: [...], interne: [...] }
// exp:     { judet, localitate, km, greutate_kg, paleti, data_ridicare, data_livrare_ceruta }
// ctx:     { azi, retur_cu_marfa, curs_eur }
function clasament(optiuni, exp, ctx) {
  const o = optiuni || {};
  const c = ctx || {};
  const azi = esteData(c.azi) ? c.azi : new Date().toISOString().slice(0, 10);
  const variante = [];
  const excluse = [];

  for (const t of o.externi || []) {
    const r = variantaExterna(t, exp, azi);
    if (r.exclus) excluse.push(r.exclus);
    else variante.push(r.varianta);
  }
  for (const v of o.interne || []) {
    const r = variantaInterna(v, exp, azi, { retur_cu_marfa: c.retur_cu_marfa });
    if (r.exclus) excluse.push(r.exclus);
    else variante.push(r.varianta);
  }

  // Data la care ajunge marfa si daca prinde termenul clientului.
  const plecare = esteData(exp && exp.data_ridicare) ? exp.data_ridicare : azi;
  const termenClient = esteData(exp && exp.data_livrare_ceruta) ? exp.data_livrare_ceruta : null;
  for (const v of variante) {
    // Comparam in lei. Un tarif in euro fara curs nu se compara cu unul in
    // lei: se marcheaza si se lasa la urma, nu se inmulteste cu 1.
    v.cost_lei = v.moneda === "RON" ? v.cost : nr(c.curs_eur) > 0 ? rotunjit(v.cost * nr(c.curs_eur)) : null;
    if (v.zile != null) {
      v.data_estimata = adaugaZile(plecare, v.zile);
      if (termenClient) {
        v.in_termen = v.data_estimata <= termenClient;
        v.intarziere = v.in_termen ? 0 : zile(termenClient, v.data_estimata);
      } else {
        v.in_termen = null;
      }
    } else {
      v.data_estimata = null;
      v.in_termen = null;
    }
  }

  // Termenul taie inaintea pretului. Un palet la Timisoara cu masina
  // noastra poate fi si mai scump SI mai lent: daca nu prinde data
  // clientului, nu e o varianta mai ieftina, e o varianta gresita.
  const ordine = (a, b) => {
    const aRau = a.in_termen === false ? 1 : 0;
    const bRau = b.in_termen === false ? 1 : 0;
    if (aRau !== bRau) return aRau - bRau;
    const aLei = a.cost_lei == null ? Infinity : a.cost_lei;
    const bLei = b.cost_lei == null ? Infinity : b.cost_lei;
    if (Math.abs(aLei - bLei) > EPS) return aLei - bLei;
    const aZ = a.zile == null ? 99 : a.zile;
    const bZ = b.zile == null ? 99 : b.zile;
    return aZ - bZ;
  };
  variante.sort(ordine);

  const recomandat = variante.find((v) => v.in_termen !== false) || null;
  const avertismente = [];

  if (!variante.length) {
    avertismente.push("Nicio variantă de transport. Vezi mai jos de ce a căzut fiecare.");
  }
  if (termenClient && variante.length && !recomandat) {
    avertismente.push("Niciun transportator nu prinde " + termenClient + ". Cea mai rapidă variantă întârzie " + variante[0].intarziere + " zile — sună clientul înainte să aloci.");
  }
  const intern = variante.find((v) => v.fel === "intern");
  const celMaiIeftinExtern = variante.find((v) => v.fel === "extern");
  if (intern && celMaiIeftinExtern && intern.cost_lei != null && celMaiIeftinExtern.cost_lei != null) {
    if (intern.cost_lei > celMaiIeftinExtern.cost_lei * 1.5) {
      avertismente.push(
        `Mașina proprie costă ${rotunjit(intern.cost_lei)} lei dus-întors pentru cursa asta, iar ${celMaiIeftinExtern.nume} o face cu ${rotunjit(celMaiIeftinExtern.cost_lei)} lei. Pentru puțină marfă la distanță mare, rețeaua de paletizare bate întotdeauna mașina proprie.`
      );
    }
  }
  if (variante.some((v) => v.cost_lei == null)) {
    avertismente.push("Un tarif e în altă monedă și n-avem cursul. Nu se poate compara până nu se scrie cursul.");
  }

  return { variante, excluse, recomandat, avertismente, azi, plecare, termen_client: termenClient };
}

module.exports = {
  EPS,
  FELURI,
  cheie,
  cifra,
  esteData,
  adaugaZile,
  zile,
  seSuprapun,
  potrivire,
  costTarif,
  costIntern,
  estLiber,
  etichetaTarif,
  clasament,
};
