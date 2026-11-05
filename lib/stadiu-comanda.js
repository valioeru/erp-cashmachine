"use strict";
// Drumul comenzii de vânzare, mutat de ce se întâmplă în producție, în
// depozit și pe drum.
//
// CEREREA LUI VALI, 05.11.2026:
//   „Când schimbăm status în finalizată, comanda să se schimbe automat peste
//    tot în ERP. Adică în comenzi să apară producție finalizată, la depozit să
//    apară de preluat în depozit, când apare în depozit să apară în comenzi în
//    depozit, apoi când din depozit e gata de livrare etc. Adică un flux
//    complet frumos."
//
// DE CE UN FIȘIER, ȘI DE CE AICI. Starea comenzii o mută patru birouri, din
// cinci pagini: lista de producție, fișa comenzii de producție, alocarea pe
// utilaje, recepția din depozit și cursa de transport. Până acum regula stătea
// într-un singur loc — fișa de producție — iar lista, din care se lucrează de
// fapt, schimba doar producția: Mihai punea „Finalizată", agentul vedea tot
// „în producție", iar depozitul nu afla nimic. Cinci copii ale aceleiași
// reguli ar fi ajuns să spună cinci lucruri diferite. Aici e una singură.
//
// DRUMUL (lib/comenzi-stari.js, FLUX):
//   nouă → confirmată → (așteaptă marfă) → în producție → producție finalizată
//   → în stoc depozit → gata de livrare → facturată → în livrare → livrată
//
// CINE MUTĂ CE:
//   • producția: „în producție" și „producție finalizată" — ultima abia când
//     TOATE comenzile de producție ale comenzii sunt gata. O comandă cu două
//     produse, din care unul încă se face, n-are ce căuta la facturare.
//   • depozitul: „în stoc depozit" când marfa a intrat și acoperă comanda,
//     „gata de livrare" când a pregătit-o.
//   • facturarea: „facturată" (modules/facturi.js, modules/comenzi.js).
//   • logistica: „în livrare" când pleacă mașina, „livrată" când a ajuns.
//
// CE NU SE FACE NICIODATĂ AUTOMAT:
//   • înapoi peste o stare pe care a pus-o alt birou. Dacă depozitul a primit
//     marfa, o răzgândire a producției nu mai scoate comanda din depozit.
//   • anularea comenzii clientului. O comandă de producție anulată pune
//     comanda pe „așteaptă marfă", iar depozitul vede cererea refuzată și
//     decide. Clientul îl pierde un om, cu motivul scris, nu un clic din altă
//     pagină.
//
// Fiecare mutare automată se scrie în istoricul clientului (interactiuni),
// ca agentul să afle fără să sune pe nimeni.
const db = require("./db");
const STARI = require("./comenzi-stari");
const livrare = require("./livrare-partiala");

// Stările comenzii de vânzare pe care le poate muta producția. De la „în stoc
// depozit" încolo marfa e a depozitului, iar producția nu mai are ce schimba.
const ZONA_PRODUCTIE = ["noua", "confirmata", "asteapta_marfa", "in_productie", "productie_finalizata"];
// Stările comenzii de producție care înseamnă „marfa e făcută".
const PRODUCTIE_GATA = ["finalizata", "facturata"];
const PRODUCTIE_IN_LUCRU = ["noua", "in_productie"];

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
const textStare = (s) => (STARI.TEXTE[s] || String(s || "").replace(/_/g, " "));
const numarComanda = (c) => (c && c.numar) || "#" + (c && c.id);

// A ajuns marfa unei comenzi de producție terminate în depozit? Da, dacă
// recepția ei e finalizată, sau — fără recepție — dacă cererea depozitului a
// intrat în stoc pe „Intră în stoc". Altfel stă încă la producție.
function marfaNepreluata(p) {
  if (p.receptie_id) return ["asteptata", "in_lucru"].includes(String(p.receptie_stare || ""));
  return String(p.cerere_stare || "") !== "primita";
}

// Starea pe care o spun comenzile de producție ale unei comenzi de vânzare.
// Rândurile: { status, receptie_id, receptie_stare, cerere_stare } (un șir
// simplu = doar starea, cu marfa socotită nepreluată).
//
//   null              — n-au nimic de spus: comanda nu trece prin producție,
//                       sau toată marfa făcută a intrat deja în depozit, iar
//                       atunci decide stocul, nu producția;
//   „așteaptă marfă"  — toate anulate: producția nu mai face nimic. NU e
//                       anulată comanda clientului; depozitul decide;
//   „în producție"    — cel puțin una încă se face;
//   „producție finalizată" — toate sunt gata, dar măcar una n-a fost preluată.
function stareDinProductie(randuri) {
  const toate = (randuri || []).map((r) => (r && typeof r === "object" ? r : { status: r }));
  if (!toate.length) return null;
  const active = toate.filter((r) => String(r.status || "") !== "anulata");
  if (!active.length) return "asteapta_marfa";
  if (active.some((r) => PRODUCTIE_IN_LUCRU.includes(String(r.status || "")))) return "in_productie";
  if (active.some((r) => PRODUCTIE_GATA.includes(String(r.status || "")) && marfaNepreluata(r))) return "productie_finalizata";
  return null;
}

async function productiaComenzii(comandaId) {
  return db
    .prepare(
      `SELECT cp.status, cp.receptie_id, r.stare AS receptie_stare, a.status AS cerere_stare
         FROM comenzi_productie cp
         LEFT JOIN receptii r ON r.id = cp.receptie_id
         LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
        WHERE cp.comanda_id = ?`
    )
    .all(comandaId);
}

// Pune starea pe comanda de vânzare și o scrie în istoricul clientului. Se
// schimbă doar dacă starea e încă cea citită: dacă între timp altcineva a
// mutat comanda, mutarea lui câștigă.
async function mutaComanda(c, stareNoua, { user, motiv } = {}) {
  if (!c || !stareNoua || c.status === stareNoua) return false;
  const r = await db.prepare("UPDATE comenzi SET status = ? WHERE id = ? AND status = ?").run(stareNoua, c.id, c.status);
  if (r && r.changes === 0) return false;
  try {
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(c.partener_id || null, `Comanda ${numarComanda(c)}: ${textStare(stareNoua)}`, motiv || null, (user && user.id) || null);
  } catch (e) {
    // Istoricul nu are voie să rupă mutarea: starea e deja scrisă.
    console.error("[stadiu] nu am putut scrie in istoric:", e.message);
  }
  return true;
}

async function comanda(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM comenzi WHERE id = ?").get(Number(id));
}

// Producția și-a schimbat starea: comanda de vânzare urmează.
async function dupaProductie(comandaId, { user, motiv } = {}) {
  const c = await comanda(comandaId);
  if (!c || !ZONA_PRODUCTIE.includes(c.status)) return { schimbat: false, status: c ? c.status : null };
  const tinta = stareDinProductie(await productiaComenzii(c.id));
  if (!tinta || tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, { user, motiv });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// Marfa a intrat în depozit (recepție finalizată sau „Intră în stoc"). Dacă
// acum stocul acoperă comanda — sau o parte, iar clientul primește livrare
// parțială —, comanda e „în stoc depozit" și agentul poate factura. Altfel
// rămâne la producție, dacă se mai face ceva, sau așteaptă marfă.
//
// `potrivire` e funcția din modules/warehouse.js; vine ca parametru ca lib/ să
// nu ceară module/ și ca testele să-i poată da o acoperire știută.
async function dupaIntrareMarfa(comandaId, { user, motiv, potrivire } = {}) {
  const c = await comanda(comandaId);
  if (!c || !ZONA_PRODUCTIE.includes(c.status) || typeof potrivire !== "function") {
    return { schimbat: false, status: c ? c.status : null };
  }
  const { acoperiteTot, acoperitePartial } = await potrivire(c.id);
  const dupaStoc = livrare.statusDupaVerificare({ acoperiteTot, acoperitePartial, comanda: c });
  // Nu acoperă încă: rămâne la producție dacă acolo mai e ceva (în lucru,
  // sau terminat și nepreluat); altfel chiar așteaptă marfă.
  const tinta = dupaStoc === "in_stoc_depozit" ? dupaStoc : stareDinProductie(await productiaComenzii(c.id)) || "asteapta_marfa";
  if (tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, {
    user,
    motiv:
      (motiv ? motiv + " " : "") +
      (tinta === "in_stoc_depozit"
        ? "Marfa e în depozit; comanda se poate factura."
        : tinta === "in_productie"
          ? "Încă se produce o parte din comandă."
          : tinta === "productie_finalizata"
            ? "Mai e marfă din producție de preluat."
            : "Ce a intrat nu acoperă comanda — așteaptă marfă."),
  });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// Depozitul a pregătit comanda: e gata de livrare. Se poate doar din „în stoc
// depozit" — înainte n-ai ce pregăti, după (facturată, în livrare) e deja
// plecată sau pe drum.
async function gataDeLivrare(comandaId, { user } = {}) {
  const c = await comanda(comandaId);
  if (!c) return { ok: false, motiv: "Comanda nu există." };
  if (c.status === "gata_livrare") return { ok: true, schimbat: false };
  if (c.status !== "in_stoc_depozit") {
    return { ok: false, motiv: `Comanda e „${textStare(c.status)}". Gata de livrare se poate pune doar când e în stoc depozit.` };
  }
  const schimbat = await mutaComanda(c, "gata_livrare", {
    user,
    motiv: `Pregătită de ${(user && user.nume) || "depozit"}; poate pleca la client.`,
  });
  if (schimbat) {
    await db
      .prepare("UPDATE comenzi SET gata_livrare_la = ?, gata_livrare_de = ? WHERE id = ?")
      .run(acum(), (user && user.nume) || null, c.id);
  }
  return { ok: true, schimbat };
}

// Cursa de transport a pornit sau a ajuns. Doar înainte: o comandă care e
// deja livrată nu se întoarce „în livrare" pentru că s-a apăsat ceva pe o
// cursă veche.
const POATE_PLECA = ["in_stoc_depozit", "gata_livrare", "facturata"];
async function dupaCursa(comandaId, stareCursa, { user, motiv } = {}) {
  const c = await comanda(comandaId);
  if (!c) return { schimbat: false, status: null };
  let tinta = null;
  if (stareCursa === "in_curs" && POATE_PLECA.includes(c.status)) tinta = "in_livrare";
  if (stareCursa === "livrata" && POATE_PLECA.concat(["in_livrare"]).includes(c.status)) {
    // A plecat doar ce s-a facturat parțial, iar restul a rămas pe comandă.
    const rest = await db
      .prepare("SELECT COALESCE(SUM(cantitate - COALESCE(cantitate_livrata, 0)), 0) AS r FROM comenzi_linii WHERE comanda_id = ?")
      .get(c.id)
      .catch(() => ({ r: 0 }));
    tinta = c.decizie_agent === "facturat_partial" && Number((rest && rest.r) || 0) > 0.0001 ? "livrata_partial" : "livrata";
  }
  if (!tinta || tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, { user, motiv });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// Producția trimite marfa în depozit: se deschide o recepție „din producție",
// pe care depozitul o preia rând cu rând. Nu scrie stoc — marfa intră pe stoc
// abia când o vede cineva din depozit.
async function trimiteInDepozit(cp, { user } = {}) {
  if (!cp) return null;
  if (cp.trimisa_depozit_la && cp.receptie_id) return Number(cp.receptie_id);
  const linii = await db
    .prepare("SELECT * FROM comenzi_productie_linii WHERE comanda_id = ? ORDER BY ordine, id")
    .all(cp.id)
    .catch(() => []);
  const deTrimis = linii.length
    ? linii.map((l) => ({ produs_id: l.produs_id || null, produs_text: l.denumire, cantitate: Number(l.cantitate) || 0, um: l.um }))
    : [{ produs_id: cp.produs_id || null, produs_text: cp.tip_produs, cantitate: Number(cp.cantitate) || 0, um: cp.um }];
  // Cerut la apel, nu sus: modules/receptie.js cere la rândul lui lib/ și nu
  // vrem un cerc de importuri la pornire.
  const receptieId = await require("../modules/receptie").creeaza(
    {
      sursa: "productie",
      comanda_productie_id: cp.id,
      comanda_id: cp.comanda_id || null,
      aprovizionare_id: cp.aprovizionare_id || null,
      anuntata_de: (user && user.nume) || null,
      observatii: "Din comanda de producție " + (cp.numar || "#" + cp.id),
    },
    deTrimis
  );
  await db
    .prepare("UPDATE comenzi_productie SET trimisa_depozit_la = ?, receptie_id = ? WHERE id = ?")
    .run(azi(), receptieId, cp.id);
  return Number(receptieId);
}

// Recepția deschisă singură la „Finalizată", închisă dacă producția revine.
// Doar cât n-a atins-o nimeni din depozit: o recepție începută are pe ea
// cantități numărate și locuri alese, și nu dispare pentru că s-a răzgândit
// altcineva.
async function retrageDinDepozit(cp) {
  if (!cp || !cp.receptie_id) return { retrasa: false };
  const r = await db.prepare("SELECT id, stare FROM receptii WHERE id = ?").get(cp.receptie_id);
  if (!r) {
    await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL, receptie_id = NULL WHERE id = ?").run(cp.id);
    return { retrasa: true };
  }
  if (r.stare !== "asteptata") return { retrasa: false, stare: r.stare };
  const atinse = await db
    .prepare("SELECT COUNT(*) AS n FROM receptii_linii WHERE receptie_id = ? AND COALESCE(stare, 'de_primit') <> 'de_primit'")
    .get(r.id);
  if (Number((atinse && atinse.n) || 0) > 0) return { retrasa: false, stare: "in_lucru" };
  await db.prepare("UPDATE receptii SET stare = 'anulata' WHERE id = ? AND stare = 'asteptata'").run(r.id);
  await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL, receptie_id = NULL WHERE id = ?").run(cp.id);
  return { retrasa: true };
}

// Ce face o schimbare de stare a comenzii de producție, oriunde s-ar face ea:
// din listă, din fișă sau de la alocarea pe utilaje.
//
//   • data finalizării: pusă la prima finalizare, ștearsă dacă se revine;
//   • cererea depozitului (aprovizionari): confirmată ↔ gata ↔ refuzată;
//   • recepția „de preluat din producție": deschisă la finalizare, retrasă la
//     revenire dacă depozitul n-a început-o;
//   • comanda de vânzare: în producție / producție finalizată / așteaptă marfă.
async function laSchimbareaProductiei(cpId, deLa, la, { user } = {}) {
  const de = String(deLa || "");
  const spre = String(la || "");
  if (!cpId || de === spre) return { schimbat: false };
  const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(Number(cpId));
  if (!cp) return { schimbat: false };
  const cine = (user && user.nume) || "producția";
  const nr = cp.numar || "#" + cp.id;
  const rezultat = { schimbat: true, receptie: null, vanzare: null };

  const eraGata = PRODUCTIE_GATA.includes(de);
  const eGata = PRODUCTIE_GATA.includes(spre);

  if (eGata && !cp.data_finalizare) {
    await db.prepare("UPDATE comenzi_productie SET data_finalizare = ? WHERE id = ?").run(azi(), cp.id);
  } else if (eraGata && !eGata) {
    await db.prepare("UPDATE comenzi_productie SET data_finalizare = NULL WHERE id = ?").run(cp.id);
  }

  if (cp.aprovizionare_id) {
    const tintaCerere = eGata ? "gata" : spre === "anulata" ? "refuzata" : PRODUCTIE_IN_LUCRU.includes(spre) ? "confirmata" : null;
    // Doar între stările pe care le-a pus producția. „Primită" (marfa e deja
    // pe stoc) și „anulată" (de depozit) nu le mai atinge nimeni.
    if (tintaCerere === "refuzata") {
      await db
        .prepare("UPDATE aprovizionari SET status = 'refuzata', raspuns = ? WHERE id = ? AND status IN ('confirmata', 'gata')")
        .run(`comanda de producție ${nr} anulată de ${cine}`, cp.aprovizionare_id);
    } else if (tintaCerere) {
      await db
        .prepare("UPDATE aprovizionari SET status = ? WHERE id = ? AND status IN ('confirmata', 'gata', 'refuzata') AND status <> ?")
        .run(tintaCerere, cp.aprovizionare_id, tintaCerere);
    }
  }

  // Recepția merge doar pe comenzile care stau în fluxul ERP-ului — legate de
  // o comandă de client sau de o cerere a depozitului. Registrul vechi, adus
  // din Excel, are sute de comenzi fără legături, făcute și livrate de mult:
  // o „Finalizată" pusă pe una din ele la curățenie nu trebuie să umple
  // depozitul cu recepții pentru marfă care a plecat de luni de zile.
  if (eGata && !eraGata && (cp.comanda_id || cp.aprovizionare_id) && !cp.trimisa_depozit_la) {
    try {
      rezultat.receptie = await trimiteInDepozit(cp, { user });
    } catch (e) {
      console.error("[stadiu] nu am putut deschide receptia din productie:", e.message);
    }
  } else if (eraGata && !eGata && cp.receptie_id) {
    try {
      rezultat.retrasa = await retrageDinDepozit(cp);
    } catch (e) {
      console.error("[stadiu] nu am putut retrage receptia:", e.message);
    }
  }

  if (cp.comanda_id) {
    const motiv = eGata
      ? `Producția (${cine}) a terminat comanda de producție ${nr}. Marfa e de preluat în depozit.`
      : spre === "anulata"
        ? `Producția (${cine}) a anulat comanda de producție ${nr}. Depozitul vede cererea refuzată și decide.`
        : `Comanda de producție ${nr} e „${spre === "noua" ? "nouă" : "în producție"}" (${cine}).`;
    rezultat.vanzare = await dupaProductie(cp.comanda_id, { user, motiv });
  }
  return rezultat;
}

// Comenzile clienților rămase în urmă față de producția lor: toate comenzile
// de producție sunt gata, dar comanda arată încă „în producție". Așa au rămas
// cele puse pe „Finalizată" din listă înainte de 05.11.2026, când lista nu
// ducea starea mai departe. Se văd pe /productie, iar un admin le aduce la zi
// cu un buton — nu singure la pornire: e o schimbare pe comenzi reale, și
// trebuie să se vadă ce se mută înainte să se mute.
async function ramaseInUrma() {
  const randuri = await db
    .prepare(
      `SELECT c.id, c.numar, c.status, pa.nume AS client,
              cp.id AS cp_id, cp.numar AS cp_numar, cp.status AS cp_status, cp.comanda_id, cp.aprovizionare_id,
              cp.trimisa_depozit_la, cp.receptie_id, r.stare AS receptie_stare, a.status AS cerere_stare
         FROM comenzi c
         JOIN comenzi_productie cp ON cp.comanda_id = c.id
         LEFT JOIN parteneri pa ON pa.id = c.partener_id
         LEFT JOIN receptii r ON r.id = cp.receptie_id
         LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
        WHERE c.status IN ('noua', 'confirmata', 'asteapta_marfa', 'in_productie')
        ORDER BY c.id, cp.id`
    )
    .all()
    .catch(() => []);
  const pe = new Map();
  for (const r of randuri) {
    if (!pe.has(r.id)) pe.set(r.id, { id: r.id, numar: r.numar, status: r.status, client: r.client, productie: [] });
    pe.get(r.id).productie.push({
      id: r.cp_id, numar: r.cp_numar, status: r.cp_status, comanda_id: r.comanda_id, aprovizionare_id: r.aprovizionare_id,
      trimisa_depozit_la: r.trimisa_depozit_la, receptie_id: r.receptie_id, receptie_stare: r.receptie_stare, cerere_stare: r.cerere_stare,
    });
  }
  // Doar cele unde producția a terminat tot; cele cu ceva încă în lucru sunt
  // la locul lor.
  return [...pe.values()].filter((c) => stareDinProductie(c.productie) === "productie_finalizata");
}

// Le aduce la zi: marfa gata intră la „De preluat din producție", cererea
// depozitului devine „gata", iar comanda clientului „producție finalizată".
// Data finalizării nu se inventează: n-o știm, deci rămâne cum era.
async function aduLaZi({ user } = {}) {
  const lista = await ramaseInUrma();
  let receptii = 0;
  let comenzi = 0;
  for (const c of lista) {
    for (const p of c.productie) {
      if (!PRODUCTIE_GATA.includes(String(p.status))) continue;
      if (p.aprovizionare_id) {
        await db.prepare("UPDATE aprovizionari SET status = 'gata' WHERE id = ? AND status = 'confirmata'").run(p.aprovizionare_id);
      }
      if (!p.trimisa_depozit_la) {
        const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(p.id);
        try {
          if (await trimiteInDepozit(cp, { user })) receptii++;
        } catch (e) {
          console.error("[stadiu] adu la zi, receptie:", e.message);
        }
      }
    }
    const r = await dupaProductie(c.id, {
      user,
      motiv: `Adusă la zi de ${(user && user.nume) || "administrator"}: comenzile de producție erau deja finalizate. Marfa e de preluat în depozit.`,
    });
    if (r.schimbat) comenzi++;
  }
  return { comenzi, receptii, total: lista.length };
}

module.exports = {
  ramaseInUrma,
  aduLaZi,
  ZONA_PRODUCTIE,
  PRODUCTIE_GATA,
  stareDinProductie,
  dupaProductie,
  dupaIntrareMarfa,
  gataDeLivrare,
  dupaCursa,
  trimiteInDepozit,
  retrageDinDepozit,
  laSchimbareaProductiei,
};
