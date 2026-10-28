"use strict";
// A cui e o serie de facturi — și care facturi stau pe firma greșită.
//
// DE UNDE A PORNIT (28.10.2026)
//
// Sincronizarea din SmartBill citea firma emitentă căutând numele prin tot
// textul paginii. Printre clienți stă și „WAREHOUSE ALL SRL", firmă din grup,
// iar când potrivirea aia venea prima, un lot întreg de facturi Cash Machine
// intra în ERP pe Warehouse All. Citirea e reparată, iar ERP-ul nu mai
// scrie a doua oară o factură cu aceeași serie și același număr — dar ce
// intrase deja pe firma greșită a rămas acolo. Prima sincronizare de după
// reparație a și arătat-o: „serie_la_alta_firma: 4".
//
// Totalurile pe grup ies corecte — o factură e numărată o singură dată,
// oriunde ar sta. Greșesc rapoartele PE FIRMĂ: Cash Machine apare cu mai
// puțin, Warehouse All cu mai mult, exact cu valoarea facturilor mutate.
//
// CUM SE RECUNOAȘTE O FACTURĂ RĂTĂCITĂ
//
// La noi seria ține de firmă: CSHM și CSHMUPA sunt Cash Machine, WHA e
// Warehouse All. Nu scriem lista asta aici. O deducem din date: firma care
// ține aproape toate facturile unei serii e a seriei, iar puținele rămase pe
// altă firmă sunt cele rătăcite. Așa merge și pentru o serie nouă, fără să
// se atingă codul, și se vede pe pagină pe ce se bazează decizia („CSHM:
// 3.128 pe Cash Machine, 4 pe Warehouse All").
//
// Când datele NU spun limpede a cui e seria — prea puține facturi, sau
// împărțite cam egal — nu decidem nimic. O serie împărțită 60/40 nu e o
// greșeală de import; e o întrebare pentru om, iar un buton care mută
// facturi pe baza unei majorități firave ar strica mai mult decât repară.
//
// Fișierul nu știe SQL: primește rânduri și întoarce rânduri, ca să-l poată
// verifica testul fără bază de date.

// Ca o serie să aibă stăpân: cel puțin atâtea facturi în total...
const MINIM_FACTURI = 10;
// ...și firma majoritară să le țină pe aproape toate.
const PRAG_COTA = 0.9;

function cheieSerie(serie) {
  return String(serie == null ? "" : serie).trim().toUpperCase();
}

// Din numărătoarea (serie, firmă, câte facturi) scoate stăpânul fiecărei
// serii. Întoarce un Map: serie → { firma_id, total, ale_proprietarului,
// cota, nedecis, motiv, pe_firme }.
function proprietari(numarari, optiuni) {
  const o = optiuni || {};
  const minim = o.minim == null ? MINIM_FACTURI : o.minim;
  const prag = o.prag == null ? PRAG_COTA : o.prag;

  const peSerie = new Map();
  for (const r of numarari || []) {
    const s = cheieSerie(r.serie);
    if (!s) continue;
    if (!peSerie.has(s)) peSerie.set(s, new Map());
    const firma = r.firma_id == null ? null : Number(r.firma_id);
    const m = peSerie.get(s);
    m.set(firma, (m.get(firma) || 0) + (Number(r.n) || 0));
  }

  const iesire = new Map();
  for (const [serie, peFirme] of peSerie) {
    let total = 0;
    let cel = null;
    let celN = -1;
    for (const [firma, n] of peFirme) {
      total += n;
      // Facturile fără firmă nu pot fi stăpânul unei serii: „nimeni" nu
      // emite facturi. Se numără în total, dar nu candidează.
      if (firma !== null && n > celN) {
        cel = firma;
        celN = n;
      }
    }
    const lista = [...peFirme.entries()]
      .map(([firma_id, n]) => ({ firma_id, n }))
      .sort((a, b) => b.n - a.n);
    const baza = { serie, total, pe_firme: lista };

    if (cel === null) {
      iesire.set(serie, { ...baza, firma_id: null, ale_proprietarului: 0, cota: 0, nedecis: true, motiv: "nicio factură nu are firmă" });
      continue;
    }
    const cota = total ? celN / total : 0;
    if (total < minim) {
      iesire.set(serie, { ...baza, firma_id: cel, ale_proprietarului: celN, cota, nedecis: true, motiv: `doar ${total} facturi — prea puține ca să se vadă a cui e seria` });
    } else if (cota < prag) {
      iesire.set(serie, { ...baza, firma_id: cel, ale_proprietarului: celN, cota, nedecis: true, motiv: `seria e împărțită între firme, ${Math.round(cota * 100)}% pe cea mai mare — de hotărât de om` });
    } else {
      iesire.set(serie, { ...baza, firma_id: cel, ale_proprietarului: celN, cota, nedecis: false, motiv: "" });
    }
  }
  return iesire;
}

// Facturile care stau pe altă firmă decât stăpânul seriei lor. Doar pentru
// seriile cu stăpân limpede — pe cele nedecise nu le atingem.
function suspecte(facturi, harta) {
  const iesire = [];
  for (const f of facturi || []) {
    const p = harta.get(cheieSerie(f.serie));
    if (!p || p.nedecis) continue;
    const acum = f.firma_id == null ? null : Number(f.firma_id);
    if (acum === p.firma_id) continue;
    iesire.push({ ...f, firma_acum: acum, firma_corecta: p.firma_id });
  }
  return iesire;
}

// Ce se scrie în istoricul mutării: de unde a plecat fiecare factură și unde
// a ajuns. Anularea pune la loc DOAR facturile care sunt încă acolo unde le-am
// pus noi — dacă între timp cineva a mutat una în altă parte, aia era o
// decizie mai nouă și nu o călcăm.
function planulMutarii(lista) {
  return (lista || []).map((f) => ({ id: Number(f.id), de_la: f.firma_acum == null ? null : Number(f.firma_acum), la: Number(f.firma_corecta) }));
}

function deAnulat(plan, stareaDeAcum) {
  // stareaDeAcum: Map id → firma_id de acum
  return (plan || []).filter((p) => {
    const acum = stareaDeAcum.get(Number(p.id));
    return acum !== undefined && Number(acum) === Number(p.la);
  });
}

module.exports = { MINIM_FACTURI, PRAG_COTA, cheieSerie, proprietari, suspecte, planulMutarii, deAnulat };
