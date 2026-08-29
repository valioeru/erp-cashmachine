"use strict";
// „Puntea" — cum intră în ERP datele care există DOAR în interfața SmartBill.
//
// Problema reală: exporturile SmartBill sunt blocate de Chrome (descărcări
// multiple), iar o parte din informație nu e nici măcar exportabilă — rețeta
// unui raport de producție sau liniile unui bon de consum se văd doar dacă
// intri în document. Singura sursă e pagina, citită din browser.
//
// Soluția: browserul citește paginile (are sesiunea utilizatorului) și trimite
// rândurile aici, prin POST.
//
// Ruta de primire NU cere parolă sau token, și e în regulă așa: nimic din ce
// intră nu atinge datele firmei. Totul aterizează într-o cutie poștală
// (punte_staging), iar administratorul vede ce a sosit — tip, număr de
// rânduri, primele rânduri — și apasă „Aplică". Cine ar trimite gunoi pe
// rută n-ar reuși decât să-și pună gunoiul într-o listă de așteptare, pe
// care adminul o șterge dintr-un clic.
//
// Alternativa (un token purtat din ERP în pagina SmartBill) ar fi însemnat
// să plimb o cheie între domenii. Cutia poștală e și mai simplă, și mai
// sigură: nu există cheie de pierdut.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const MAX_OCTETI = 6 * 1024 * 1024; // ~6 MB per lot
const MAX_RANDURI = 5000;
const MAX_LOTURI_PASTRATE = 60;

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// --- normalizări comune ---------------------------------------------------
const nr = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  let s = String(v).trim().replace(/\s/g, "").replace(/[^0-9,.\-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};
const data = (v) => {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
};
const curat = (v) => String(v === null || v === undefined ? "" : v).trim();

// --- produse ---------------------------------------------------------------
// Cheia de identitate e codul; dacă lipsește, denumirea. Reimportul
// actualizează prețurile, nu creează duplicate.
async function ingestProduse(randuri) {
  let noi = 0, actualizate = 0, sarite = 0;
  const dupaCod = new Map();
  const dupaDenumire = new Map();
  for (const p of await db.prepare("SELECT id, cod, denumire FROM produse").all()) {
    if (p.cod) dupaCod.set(String(p.cod).trim().toLowerCase(), p.id);
    dupaDenumire.set(String(p.denumire).trim().toLowerCase(), p.id);
  }
  for (const r of randuri) {
    const denumire = curat(r.denumire);
    const cod = curat(r.cod);
    if (!denumire) { sarite++; continue; }
    const um = curat(r.um) || "buc";
    const pv = nr(r.pret_vanzare);
    const pa = nr(r.pret_achizitie);
    const tva = r.cota_tva === undefined || r.cota_tva === "" ? 21 : nr(r.cota_tva);
    const id = (cod && dupaCod.get(cod.toLowerCase())) || dupaDenumire.get(denumire.toLowerCase());
    if (id) {
      // Nu ștergem un preț existent cu zero — importul poate veni parțial.
      // Parametrii numerici sunt turnați explicit: fără CAST, PostgreSQL
      // deduce tipul din „? > 0" și presupune întreg, apoi crapă pe primul
      // preț cu zecimale (bug real: „invalid input syntax for integer 98.34").
      await db
        .prepare(
          `UPDATE produse SET cod = COALESCE(NULLIF(?, ''), cod),
                              unitate_masura = COALESCE(NULLIF(?, ''), unitate_masura),
                              pret_vanzare = CASE WHEN CAST(? AS DOUBLE PRECISION) > 0 THEN CAST(? AS DOUBLE PRECISION) ELSE pret_vanzare END,
                              pret_achizitie = CASE WHEN CAST(? AS DOUBLE PRECISION) > 0 THEN CAST(? AS DOUBLE PRECISION) ELSE pret_achizitie END,
                              cota_tva = CASE WHEN CAST(? AS DOUBLE PRECISION) > 0 THEN CAST(? AS DOUBLE PRECISION) ELSE cota_tva END
            WHERE id = ?`
        )
        .run(cod, um, pv, pv, pa, pa, tva, tva, id);
      actualizate++;
    } else {
      const ins = await db
        .prepare("INSERT INTO produse (cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, cota_tva) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .run(cod || null, denumire, um, pv, pa, tva);
      if (cod) dupaCod.set(cod.toLowerCase(), ins.lastInsertRowid);
      dupaDenumire.set(denumire.toLowerCase(), ins.lastInsertRowid);
      noi++;
    }
  }
  return { noi, actualizate, sarite };
}

// --- stoc ------------------------------------------------------------------
// Stocul la zi se scrie ca o singură mișcare de "inventar" per produs/gestiune,
// înlocuind inventarul anterior din aceeași sursă — altfel reimportul ar dubla
// cantitățile.
async function ingestStoc(randuri) {
  let scrise = 0, produseNoi = 0, sarite = 0;
  const depozite = new Map((await db.prepare("SELECT id, denumire FROM depozite").all()).map((d) => [String(d.denumire).trim().toLowerCase(), d.id]));
  const produse = new Map();
  for (const p of await db.prepare("SELECT id, cod, denumire FROM produse").all()) {
    produse.set(String(p.denumire).trim().toLowerCase(), p.id);
    if (p.cod) produse.set(String(p.cod).trim().toLowerCase(), p.id);
  }
  await db.prepare("DELETE FROM miscari_stoc WHERE tip = 'inventar' AND observatii = 'stoc la zi din SmartBill'").run();
  for (const r of randuri) {
    const denumire = curat(r.produs);
    if (!denumire) { sarite++; continue; }
    const gestiune = curat(r.gestiune) || "Depozit principal";
    const cant = nr(r.cantitate);
    const valoare = nr(r.valoare);
    let depId = depozite.get(gestiune.toLowerCase());
    if (!depId) {
      const ins = await db.prepare("INSERT INTO depozite (denumire) VALUES (?) RETURNING id").run(gestiune);
      depId = ins.lastInsertRowid;
      depozite.set(gestiune.toLowerCase(), depId);
    }
    let prodId = produse.get(denumire.toLowerCase()) || (curat(r.cod) && produse.get(curat(r.cod).toLowerCase()));
    if (!prodId) {
      const ins = await db.prepare("INSERT INTO produse (cod, denumire, unitate_masura) VALUES (?, ?, ?) RETURNING id").run(curat(r.cod) || null, denumire, curat(r.um) || "buc");
      prodId = ins.lastInsertRowid;
      produse.set(denumire.toLowerCase(), prodId);
      produseNoi++;
    }
    const pretUnit = cant > 0 && valoare > 0 ? valoare / cant : 0;
    await db
      .prepare("INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data, observatii) VALUES (?, ?, 'inventar', ?, ?, ?, ?, 'stoc la zi din SmartBill')")
      .run(prodId, depId, cant, pretUnit, "STOC-SB", data(r.data) || new Date().toISOString().slice(0, 10));
    scrise++;
  }
  return { scrise, produseNoi, sarite };
}

// --- rapoarte de producție (dau și rețeta) ---------------------------------
// Un raport de producție are, în detaliu, produsul finit obținut și materiile
// prime consumate. Din perechea asta rezultă rețeta: pentru 1 unitate de
// produs finit, cât intră din fiecare componentă. O reconstruim ca medie pe
// toate rapoartele în care apare produsul — mai stabilă decât un singur raport.
async function ingestProductie(randuri) {
  let documente = 0, liniiFinite = 0, liniiConsum = 0, retete = 0;
  const produse = new Map();
  for (const p of await db.prepare("SELECT id, cod, denumire FROM produse").all()) {
    produse.set(String(p.denumire).trim().toLowerCase(), p.id);
    if (p.cod) produse.set(String(p.cod).trim().toLowerCase(), p.id);
  }
  const idProdus = async (denumire, cod, um) => {
    const cheie = String(denumire || "").trim().toLowerCase();
    if (!cheie) return null;
    if (produse.has(cheie)) return produse.get(cheie);
    if (cod && produse.has(String(cod).trim().toLowerCase())) return produse.get(String(cod).trim().toLowerCase());
    const ins = await db.prepare("INSERT INTO produse (cod, denumire, unitate_masura) VALUES (?, ?, ?) RETURNING id").run(cod || null, denumire, um || "buc");
    produse.set(cheie, ins.lastInsertRowid);
    return ins.lastInsertRowid;
  };

  // acumulăm cantitățile pe pereche (finit, componentă)
  const perechi = new Map();
  for (const doc of randuri) {
    documente++;
    const finite = (doc.finite || []).filter((x) => curat(x.produs));
    const consum = (doc.consum || []).filter((x) => curat(x.produs));
    liniiFinite += finite.length;
    liniiConsum += consum.length;
    if (!finite.length || !consum.length) continue;
    // dacă raportul are un singur produs finit, tot consumul îi aparține;
    // dacă are mai multe, împărțim proporțional cu cantitatea produsă
    const totalFinit = finite.reduce((s, f) => s + Math.abs(nr(f.cantitate)), 0);
    if (!(totalFinit > 0)) continue;
    for (const f of finite) {
      const cantF = Math.abs(nr(f.cantitate));
      if (!(cantF > 0)) continue;
      const cota = cantF / totalFinit;
      const idF = await idProdus(f.produs, f.cod, f.um);
      if (!idF) continue;
      for (const c of consum) {
        const idC = await idProdus(c.produs, c.cod, c.um);
        if (!idC || idC === idF) continue;
        const cantC = Math.abs(nr(c.cantitate)) * cota;
        if (!(cantC > 0)) continue;
        const k = `${idF}|${idC}`;
        const g = perechi.get(k) || { finit: idF, comp: idC, cantC: 0, cantF: 0 };
        g.cantC += cantC;
        g.cantF += cantF;
        perechi.set(k, g);
      }
    }
  }

  for (const g of perechi.values()) {
    if (!(g.cantF > 0)) continue;
    const perUnitate = g.cantC / g.cantF;
    if (!(perUnitate > 0)) continue;
    const existent = await db.prepare("SELECT id FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").get(g.finit, g.comp);
    if (existent) await db.prepare("UPDATE retete_componente SET cantitate = ? WHERE id = ?").run(Math.round(perUnitate * 1e6) / 1e6, existent.id);
    else await db.prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)").run(g.finit, g.comp, Math.round(perUnitate * 1e6) / 1e6);
    retete++;
  }
  return { documente, liniiFinite, liniiConsum, retete };
}

// --- bonuri de consum ------------------------------------------------------
async function ingestConsum(randuri) {
  let linii = 0, sarite = 0;
  const produse = new Map();
  for (const p of await db.prepare("SELECT id, cod, denumire FROM produse").all()) {
    produse.set(String(p.denumire).trim().toLowerCase(), p.id);
    if (p.cod) produse.set(String(p.cod).trim().toLowerCase(), p.id);
  }
  const depozite = new Map((await db.prepare("SELECT id, denumire FROM depozite").all()).map((d) => [String(d.denumire).trim().toLowerCase(), d.id]));
  for (const r of randuri) {
    const denumire = curat(r.produs);
    if (!denumire) { sarite++; continue; }
    const gestiune = curat(r.gestiune) || "Depozit principal";
    let depId = depozite.get(gestiune.toLowerCase());
    if (!depId) {
      const ins = await db.prepare("INSERT INTO depozite (denumire) VALUES (?) RETURNING id").run(gestiune);
      depId = ins.lastInsertRowid;
      depozite.set(gestiune.toLowerCase(), depId);
    }
    let prodId = produse.get(denumire.toLowerCase());
    if (!prodId) {
      const ins = await db.prepare("INSERT INTO produse (cod, denumire, unitate_masura) VALUES (?, ?, ?) RETURNING id").run(curat(r.cod) || null, denumire, curat(r.um) || "buc");
      prodId = ins.lastInsertRowid;
      produse.set(denumire.toLowerCase(), prodId);
    }
    const ref = curat(r.document) || "BC-SB";
    const d = data(r.data) || new Date().toISOString().slice(0, 10);
    const cant = Math.abs(nr(r.cantitate));
    if (!(cant > 0)) { sarite++; continue; }
    const dubla = await db.prepare("SELECT id FROM miscari_stoc WHERE document_ref = ? AND produs_id = ? AND tip = 'iesire'").get(ref, prodId);
    if (dubla) { sarite++; continue; }
    await db
      .prepare("INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data, observatii) VALUES (?, ?, 'iesire', ?, ?, ?, ?, 'bon de consum din SmartBill')")
      .run(prodId, depId, cant, nr(r.pret_unitar), ref, d);
    linii++;
  }
  return { linii, sarite };
}

// --- profitabilitate pe produs --------------------------------------------
// Cifrele vin gata calculate din SmartBill Gestiune, cu costul real al
// bunurilor vândute. Le luăm ca atare — e singura sursă serioasă de marjă
// pe produs până când facturile din ERP vor avea produsul pe linie.
async function ingestProfitProdus(randuri) {
  let scrise = 0, legate = 0;
  const norm = (v) =>
    String(v || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const produse = await db.prepare("SELECT id, cod, denumire FROM produse").all();
  const dupaNume = new Map();
  const dupaCod = new Map();
  for (const p of produse) {
    const n = norm(p.denumire);
    if (n && !dupaNume.has(n)) dupaNume.set(n, p.id);
    const c = norm(p.cod);
    if (c && !dupaCod.has(c)) dupaCod.set(c, p.id);
  }
  await db.prepare("DELETE FROM profit_produs").run();
  for (const r of randuri) {
    const den = curat(r.produs);
    if (!den) continue;
    const pid = dupaCod.get(norm(r.cod)) || dupaNume.get(norm(den)) || null;
    if (pid) legate++;
    await db
      .prepare(
        `INSERT INTO profit_produs (produs_id, denumire, cod, gestiune, vanzari_brute, discount, vanzari_nete, cost, profit, marja_pct, perioada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(pid, den, curat(r.cod) || null, curat(r.gestiune) || null, nr(r.vanzari_brute), nr(r.discount), nr(r.vanzari_nete), nr(r.cost), nr(r.profit), nr(r.marja_pct), curat(r.perioada) || null);
    scrise++;
  }
  return { scrise, legate_de_produse: legate };
}

// --- liniile facturilor ----------------------------------------------------
// Exportul SmartBill de facturi n-are detaliu pe produse: toate cele ~6.900
// de linii importate sunt un text de forma „Conform document …". Fără produs
// pe linie nu există cost, deci nu există marjă pe factură, pe client sau pe
// produs — exact ce a cerut Vali.
//
// Aici intră liniile citite din pagina fiecărei facturi. Regula: o factură
// primită în lot își pierde liniile vechi și le capătă pe cele noi, o singură
// dată, în bloc. Nu completăm parțial: ori știm factura întreagă, ori o lăsăm
// cum era.
async function ingestFacturiLinii(randuri) {
  let facturi = 0, linii = 0, negasite = 0, faraProdus = 0;

  const idxProduse = indexProduse(await db.prepare("SELECT id, cod, denumire, pret_achizitie FROM produse").all());

  // Grupăm rândurile pe factură. Cheia e ce ne dă browserul: numărul
  // documentului aşa cum apare în SmartBill (ex. „CSHM 3080").
  const peFactura = new Map();
  for (const r of randuri) {
    const cheie = curat(r.factura) || `${curat(r.serie)} ${curat(r.numar)}`.trim();
    if (!cheie) continue;
    if (!peFactura.has(cheie)) peFactura.set(cheie, []);
    peFactura.get(cheie).push(r);
  }

  for (const [cheie, aleFacturii] of peFactura) {
    // „CSHM 3080" / „CSHMUPA0041" / „CSHM3080" — despărțim seria de număr.
    const m = String(cheie).trim().match(/^([A-Za-z][A-Za-z0-9]*?)\s*0*(\d+)$/);
    const serie = m ? m[1].toUpperCase() : null;
    const numar = m ? parseInt(m[2], 10) : null;

    let f = null;
    if (serie && Number.isFinite(numar)) {
      f = await db
        .prepare("SELECT id FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare' AND UPPER(COALESCE(serie,'')) = ? AND numar = ? ORDER BY id LIMIT 1")
        .get(serie, numar);
    }
    if (!f) {
      f = await db
        .prepare("SELECT id FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare' AND REPLACE(UPPER(COALESCE(document_extern,'')), ' ', '') = ? ORDER BY id LIMIT 1")
        .get(String(cheie).toUpperCase().replace(/\s/g, ""));
    }
    if (!f) {
      negasite++;
      continue;
    }

    await db.prepare("DELETE FROM facturi_linii WHERE factura_id = ?").run(f.id);
    for (const r of aleFacturii) {
      const denumire = curat(r.denumire) || curat(r.produs);
      if (!denumire) continue;
      const cod = curat(r.cod);
      const potriviri = potrivesteProdus(idxProduse, cod, denumire);
      const produsId = potriviri.length ? potriviri[0].id : null;
      if (!produsId) faraProdus++;
      const cant = nr(r.cantitate);
      const pret = nr(r.pret_unitar);
      const tva = r.cota_tva === undefined || r.cota_tva === null || r.cota_tva === "" ? 21 : nr(r.cota_tva);
      await db
        .prepare("INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)")
        .run(f.id, produsId, denumire.slice(0, 300), cant, pret, tva);
      linii++;
    }
    facturi++;
  }

  return {
    facturi,
    linii,
    negasite,
    faraProdus,
    nota:
      negasite > 0
        ? `${negasite} facturi din lot n-au fost găsite în ERP după serie+număr — probabil nu sunt importate.`
        : undefined,
  };
}

// Balanțele din SmartBill Conta, citite direct din pagina lui Conta prin
// punte — ca să nu mai exporte Vali fișiere și să le urce el.
//
// O balanță se identifică prin eticheta ei (perioada). Aceeași etichetă
// înlocuiește ce era: o balanță reîncărcată e o corectură, nu un al doilea
// adevăr pentru aceeași lună.
async function ingestBalante(randuri) {
  const peEticheta = new Map();
  for (const r of randuri) {
    const cont = String((r && r.cont) || "").replace(/[^0-9.]/g, "");
    if (!/^\d{3,4}(\.\d+)?$/.test(cont)) continue;
    const eticheta = String(r.eticheta || "").trim() || "balanță fără perioadă";
    if (!peEticheta.has(eticheta)) peEticheta.set(eticheta, []);
    peEticheta.get(eticheta).push({ ...r, cont });
  }

  let etichete = 0;
  let conturi = 0;
  const detalii = [];
  for (const [eticheta, linii] of peEticheta) {
    await db.prepare("DELETE FROM balante_snapshot WHERE eticheta = ?").run(eticheta);
    for (let i = 0; i < linii.length; i += 100) {
      const lot = linii.slice(i, i + 100);
      const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const args = [];
      for (const c of lot) {
        args.push(
          eticheta,
          c.data_de_la ? String(c.data_de_la).slice(0, 10) : null,
          c.data_pana ? String(c.data_pana).slice(0, 10) : null,
          c.cont,
          String(c.denumire || "").slice(0, 300),
          nr(c.si_d), nr(c.si_c), nr(c.r_d), nr(c.r_c), nr(c.ts_d), nr(c.ts_c), nr(c.sf_d), nr(c.sf_c),
          "punte Conta"
        );
      }
      await db
        .prepare(
          `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, si_d, si_c, r_d, r_c, ts_d, ts_c, sf_d, sf_c, fisier) VALUES ${ph}`
        )
        .run(...args);
    }
    // Verificarea care contează: rezultatul perioadei, socotit la fel ca pe
    // dashboard — din contul 121 dacă e în balanță, altfel din rulajele
    // claselor 7 și 6. Dacă cifra de aici nu seamănă cu ce știe Vali, se vede
    // pe loc, nu peste o săptămână.
    const c121 = linii.find((c) => c.cont === "121");
    const rezultat = c121
      ? nr(c121.r_c) - nr(c121.r_d)
      : linii.filter((c) => c.cont.startsWith("7")).reduce((s, c) => s + (nr(c.r_c) - nr(c.r_d)), 0) -
        linii.filter((c) => c.cont.startsWith("6")).reduce((s, c) => s + (nr(c.r_d) - nr(c.r_c)), 0);
    detalii.push(
      `${eticheta}: ${linii.length} ${linii.length === 1 ? "cont" : "conturi"}, rezultat ${Math.round(rezultat).toLocaleString("ro-RO")} lei${
        c121 ? " (din contul 121)" : ""
      }`
    );
    etichete++;
    conturi += linii.length;
  }

  return {
    rezumat: `${etichete} ${etichete === 1 ? "balanță" : "balanțe"}, ${conturi} rânduri de cont`,
    detalii,
  };
}

// --- facturile întregi (pentru firma a doua din grup) ----------------------
// Cash Machine își are facturile din exportul SmartBill. Warehouse All are
// alt cont SmartBill, cu altă sesiune — nu pot fi deschise amândouă odată,
// iar exportul multiplu e blocat de browser. Așa că facturile ei intră tot
// prin punte: se citește raportul de facturi din pagină și se trimite aici.
//
// Regula grupului: Cash Machine facturează marfă către Warehouse All, iar
// Warehouse All mai departe către clientul final. Vânzarea reală către piață
// e a doua. Prima e mutare în interiorul grupului și se marchează
// „intercompany" la final, ca să nu fie numărat același leu de două ori.
//
// Partenerii sunt comuni pe tot grupul: un client al Warehouse care e deja
// client la Cash Machine e ACELAȘI rând, cu același agent. De-aia comisionul
// iese corect fără nicio potrivire în plus.
async function ingestFacturi(randuri) {
  const grup = require("../lib/grup");
  let create = 0, sarite = 0, parteneriNoi = 0, cuPlata = 0;
  const erori = [];

  const firme = await db.prepare("SELECT id, nume, cui FROM firme").all();
  const normCui = (v) => String(v || "").replace(/[^0-9]/g, "");
  const firmaDupaCui = new Map(firme.map((f) => [normCui(f.cui), f.id]));
  const firmaDupaNume = new Map(firme.map((f) => [String(f.nume || "").toLowerCase(), f.id]));
  const implicita = (await grup.firmaImplicita()) || {};

  const parteneri = await db.prepare("SELECT id, nume, cui, tip FROM parteneri").all();
  const pDupaCui = new Map();
  const pDupaNume = new Map();
  for (const p of parteneri) {
    if (normCui(p.cui)) pDupaCui.set(normCui(p.cui), p.id);
    pDupaNume.set(String(p.nume || "").trim().toLowerCase(), p.id);
  }

  // cheile facturilor deja existente, ca reimportul aceluiași raport să nu dubleze
  const existente = new Set();
  for (const f of await db.prepare("SELECT serie, numar, firma_id FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare'").all()) {
    existente.add(`${String(f.serie || "").toUpperCase()}|${f.numar}|${f.firma_id || ""}`);
  }

  const admin = await db.prepare("SELECT id FROM utilizatori WHERE rol = 'admin' ORDER BY id LIMIT 1").get();

  for (const r of randuri) {
    const numeClient = curat(r.client) || curat(r.partener);
    if (!numeClient) { sarite++; continue; }

    // seria și numărul: fie date separat, fie lipite („CSHM3160")
    let serie = curat(r.serie);
    let numar = curat(r.numar);
    if (!serie || !numar) {
      const doc = curat(r.document) || curat(r.factura) || curat(r.cheie);
      const m = doc.match(/^([A-Za-z][A-Za-z0-9]*?)[\s-]*(\d+)$/);
      if (m) { serie = serie || m[1]; numar = numar || m[2]; }
      else { serie = serie || doc; }
    }
    if (!serie && !numar) { sarite++; continue; }

    const firmaId =
      firmaDupaCui.get(normCui(r.firma_cui)) ||
      firmaDupaNume.get(String(curat(r.firma)).toLowerCase()) ||
      implicita.id ||
      null;

    const cheie = `${String(serie).toUpperCase()}|${numar}|${firmaId || ""}`;
    if (existente.has(cheie)) { sarite++; continue; }

    // partenerul: întâi după CUI, apoi după nume; comun pe tot grupul
    const cui = normCui(r.cui);
    let partenerId = (cui && pDupaCui.get(cui)) || pDupaNume.get(numeClient.toLowerCase()) || null;
    if (!partenerId) {
      const ins = await db
        .prepare("INSERT INTO parteneri (tip, nume, cui, agent_id) VALUES ('client', ?, ?, ?) RETURNING id")
        .run(numeClient.slice(0, 200), curat(r.cui) || null, admin ? admin.id : null);
      partenerId = ins.lastInsertRowid;
      if (cui) pDupaCui.set(cui, partenerId);
      pDupaNume.set(numeClient.toLowerCase(), partenerId);
      parteneriNoi++;
    }

    const dataEmiterii = data(r.data) || data(r.data_emiterii);
    if (!dataEmiterii) { erori.push(`${serie}${numar}: dată nevalidă`); sarite++; continue; }
    const net = nr(r.net !== undefined ? r.net : r.fara_tva);
    const tva = nr(r.tva);
    const total = nr(r.total) || net + tva;
    const stareBruta = String(curat(r.status)).toLowerCase();
    const status = /anulat|storn/.test(stareBruta) ? "anulata" : /ciorn|schita/.test(stareBruta) ? "ciorna" : "emisa";

    try {
      const ins = await db
        .prepare(
          `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, moneda, sursa_import, document_extern, firma_id)
           VALUES (?, ?, ?, 'vanzare', ?, ?, ?, ?, 'punte SmartBill', ?, ?) RETURNING id`
        )
        .run(
          String(serie).slice(0, 20),
          parseInt(numar, 10) || null,
          partenerId,
          dataEmiterii,
          data(r.scadenta) || data(r.data_scadenta),
          status,
          curat(r.moneda) || "RON",
          `${serie}${numar}`,
          firmaId
        );
      const facturaId = ins.lastInsertRowid;

      // O linie „conform document", ca la importul din export: fără detaliu pe
      // produse totalul trebuie totuși să iasă la ban. Cota de TVA se
      // reconstituie din raport, cu 4 zecimale, nu rotunjită.
      const cota = net !== 0 ? Math.round((tva / net) * 1000000) / 10000 : 0;
      await db
        .prepare("INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, 1, ?, ?)")
        .run(facturaId, `Conform document ${serie}${numar} (punte SmartBill, fără detaliu pe produse)`, net !== 0 ? net : total, cota);

      // Încasarea, dacă raportul o dă. Fără ea factura rămâne neîncasată —
      // mai bine așa decât o plată inventată.
      const incasat = nr(r.incasat !== undefined ? r.incasat : r.platit);
      if (incasat > 0) {
        await db
          .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (?, ?, ?, 'import', ?)")
          .run(facturaId, incasat, data(r.data_incasarii) || dataEmiterii, "Încasare adusă prin punte din SmartBill");
        cuPlata++;
      }
      existente.add(cheie);
      create++;
    } catch (e) {
      erori.push(`${serie}${numar}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }

  const marcaje = await grup.marcheazaIntercompany();
  return {
    facturi: create,
    sarite,
    parteneri_noi: parteneriNoi,
    cu_plata: cuPlata,
    intercompany_marcate: marcaje.facturiMarcate,
    erori: erori.slice(0, 20),
  };
}

// --- costul de achiziție pe produs, din balanța stocului --------------------
// Balanța stocului din SmartBill dă, pe fiecare produs, cantitatea și valoarea
// pe intrări, ieșiri și sold. Împărțite, dau costul unitar — singurul cost real
// disponibil pe produsele care nu mai au stoc, deci nu apar în evaluarea de
// inventar.
//
// Ordinea de preferință: costul mărfii IEȘITE (ăsta e costul vânzării, exact ce
// intră în marjă), apoi al celei INTRATE, apoi al stocului rămas.
//
// Handlerul ăsta NU creează produse. Dacă numele nu se potrivește cu nimic din
// nomenclator, rândul e raportat ca nepotrivit și atât — altfel am umple lista
// de produse cu dubluri, exact problema pe care încercăm s-o reparăm.
// Potrivirea denumirilor intre ERP si rapoartele din contabilitate.
// In ERP denumirile poarta adesea un sufix de firma ("... /400M CM"), iar in balanta
// de stoc poarta un cod intre paranteze ("... /400M (167...)"). Dupa potrivirea exacta
// incercam potrivirea pe prefix: una dintre denumiri o incepe pe cealalta. Daca mai
// multe produse din ERP pornesc la fel (acelasi articol trecut de doua ori, cu coduri
// diferite), costul se pune pe toate, fiind aceeasi marfa.
const normCod = (v) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

const normNume = (v) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]/g, "");

const PREFIX_MIN = 12;
const PREFIX_ACOPERIRE = 0.6;
const PREFIX_GRUP_MAX = 4;

function indexProduse(produse) {
  const dupaCod = new Map();
  const dupaNume = new Map();
  const galeti = new Map();
  for (const p of produse) {
    const c = normCod(p.cod);
    if (c && !dupaCod.has(c)) dupaCod.set(c, p);
    const n = normNume(p.denumire);
    if (!n) continue;
    if (!dupaNume.has(n)) dupaNume.set(n, []);
    dupaNume.get(n).push(p);
    if (n.length < PREFIX_MIN) continue;
    const k = n.slice(0, 8);
    if (!galeti.has(k)) galeti.set(k, []);
    galeti.get(k).push({ n, p });
  }
  return { dupaCod, dupaNume, galeti };
}

function potrivesteProdus(idx, cod, den) {
  const gasite = new Map();
  const dinCod = cod ? idx.dupaCod.get(normCod(cod)) : null;
  if (dinCod) gasite.set(dinCod.id, dinCod);

  const n = normNume(den);
  const exact = (n && idx.dupaNume.get(n)) || [];
  if (n && n.length >= PREFIX_MIN) {
    for (const it of idx.galeti.get(n.slice(0, 8)) || []) {
      const scurt = Math.min(it.n.length, n.length);
      const lung = Math.max(it.n.length, n.length);
      if (scurt < PREFIX_MIN) continue;
      if (scurt < PREFIX_ACOPERIRE * lung) continue;
      if (it.n.slice(0, scurt) === n.slice(0, scurt)) gasite.set(it.p.id, it.p);
    }
    // prea multe produse pornesc la fel: ramanem doar la potrivirea exacta
    if (gasite.size > PREFIX_GRUP_MAX) {
      gasite.clear();
      if (dinCod) gasite.set(dinCod.id, dinCod);
      for (const p of exact) gasite.set(p.id, p);
    }
  } else {
    for (const p of exact) gasite.set(p.id, p);
  }

  if (!gasite.size || gasite.size > PREFIX_GRUP_MAX) return [];
  return [...gasite.values()];
}

// Costul scos din balanța stocului e valoare / cantitate. Când stocul e
// negativ sau cantitatea e trecută în altă unitate decât cea de pe factură,
// raportul explodează — un sac vândut cu 0,57 lei ajunge cu „cost" 499,42 lei,
// iar o linie de 50.000 de bucăți scoate marja firmei pe minus cu 25 de
// milioane. De aceea costul se compară cu prețul la care produsul chiar se
// vinde (prețul lui de vânzare sau media de pe facturi, care e mai mare) și,
// dacă îl depășește de peste cinci ori, nu se scrie deloc.
const PRAG_COST_ABERANT = 5;

async function ingestCostProduse(randuri) {
  const produse = await db
    .prepare(
      `SELECT pr.id, pr.cod, pr.denumire, pr.pret_achizitie, pr.pret_vanzare,
              COALESCE(v.pret_mediu, 0) AS pret_mediu
         FROM produse pr
         LEFT JOIN (SELECT fl.produs_id,
                           SUM(fl.cantitate * fl.pret_unitar) / NULLIF(SUM(fl.cantitate), 0) AS pret_mediu
                      FROM facturi_linii fl
                      JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
                     WHERE f.directie = 'vanzare' AND fl.cantitate > 0
                     GROUP BY fl.produs_id) v ON v.produs_id = pr.id`
    )
    .all();
  const idx = indexProduse(produse);

  let completate = 0;
  let aveauDeja = 0;
  let faraCost = 0;
  let nepotriviteN = 0;
  let aberante = 0;
  const exempleAberante = [];
  const exemple = [];
  const vazute = new Set();

  for (const r of randuri) {
    const den = curat(r.denumire) || curat(r.produs);
    const cod = curat(r.cod);
    if (!den && !cod) continue;

    const gasite = potrivesteProdus(idx, cod, den);
    if (!gasite.length) {
      nepotriviteN++;
      if (exemple.length < 25) exemple.push(den || cod);
      continue;
    }

    // costul unitar: intai de pe marfa iesita, apoi de pe cea intrata, apoi stoc
    const perechi = [
      [nr(r.valoare_iesiri), nr(r.cantitate_iesiri)],
      [nr(r.valoare_intrari), nr(r.cantitate_intrari)],
      [nr(r.valoare_stoc), nr(r.cantitate_stoc)],
    ];
    let cost = 0;
    for (const [val, cant] of perechi) {
      if (val > 0 && cant > 0) {
        cost = val / cant;
        break;
      }
    }
    if (!(cost > 0)) {
      faraCost++;
      continue;
    }
    const rotunjit = Math.round(cost * 10000) / 10000;

    for (const p of gasite) {
      if (vazute.has(p.id)) continue;
      vazute.add(p.id);
      if (Number(p.pret_achizitie) > 0) {
        aveauDeja++;
        continue;
      }
      const referinta = Math.max(Number(p.pret_vanzare) || 0, Number(p.pret_mediu) || 0);
      if (referinta > 0 && rotunjit > PRAG_COST_ABERANT * referinta) {
        aberante++;
        if (exempleAberante.length < 15) {
          exempleAberante.push(`${p.denumire || p.cod}: cost ${rotunjit} față de preț de vânzare ${referinta}`);
        }
        continue;
      }
      await db.prepare("UPDATE produse SET pret_achizitie = ? WHERE id = ?").run(rotunjit, p.id);
      p.pret_achizitie = rotunjit;
      completate++;
    }
  }

  const cuCost = await db.prepare("SELECT COUNT(*) AS n FROM produse WHERE COALESCE(pret_achizitie,0) > 0").get();
  const liniiCuCost = await db
    .prepare("SELECT COUNT(*) AS n FROM facturi_linii fl JOIN produse p ON p.id = fl.produs_id WHERE COALESCE(p.pret_achizitie,0) > 0")
    .get();

  return {
    completate,
    aveau_deja_cost: aveauDeja,
    fara_cost_in_raport: faraCost,
    nepotrivite: nepotriviteN,
    costuri_aberante_sarite: aberante,
    exemple_aberante: exempleAberante,
    exemple_nepotrivite: exemple.slice(0, 15),
    produse_cu_cost_acum: Number(cuCost.n),
    linii_de_factura_cu_cost: Number(liniiCuCost.n),
  };
}

// Plati catre furnizori, reconciliate din raportul SmartBill de documente
// furnizori. Nu inventam plati: luam suma achitata pe care o stie SmartBill si
// completam diferenta fata de ce e deja in ERP, cu o nota proprie, ca sa poata
// fi refacuta oricand. Statusul se schimba doar in bine (spre platit), niciodata
// invers, ca sa nu umflam datoria din greseala.
const NOTA_RECONCILIERE = "reconciliere SmartBill";

function doarCifre(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

async function ingestPlatiFurnizori(randuri) {
  let potrivite = 0;
  let negasite = 0;
  let platiScrise = 0;
  let statusSchimbat = 0;
  let sumaScrisa = 0;
  const exemple = [];

  for (const r of randuri) {
    const doc = String(r.document || "").toUpperCase().replace(/\s+/g, "");
    if (!doc) continue;
    const cui = doarCifre(r.cui);

    const gasite = await db
      .prepare(
        `SELECT f.id, f.status, p.cui AS cui FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN parteneri p ON p.id = f.partener_id
          WHERE f.directie = 'achizitie'
            AND REPLACE(UPPER(COALESCE(f.document_extern, '')), ' ', '') = ?`
      )
      .all(doc);

    let f = gasite[0] || null;
    if (gasite.length > 1 && cui) {
      f = gasite.find((g) => doarCifre(g.cui) && doarCifre(g.cui) === cui) || gasite[0];
    }
    if (!f) {
      negasite++;
      if (exemple.length < 20) exemple.push(String(r.document || "").slice(0, 60));
      continue;
    }
    potrivite++;
    if (f.status === "anulata") continue;

    const platit = Math.round(nr(r.platit) * 100) / 100;
    const total = Math.round(nr(r.total) * 100) / 100;

    await db.prepare("DELETE FROM plati WHERE factura_id = ? AND observatii = ?").run(f.id, NOTA_RECONCILIERE);
    const alte = await db.prepare("SELECT COALESCE(SUM(suma), 0) AS s FROM (SELECT * FROM plati WHERE activ = 1) plati WHERE factura_id = ?").get(f.id);
    const lipsa = Math.round((platit - Number(alte.s || 0)) * 100) / 100;
    if (lipsa > 0.009) {
      const data = String(r.data || "").slice(0, 10) || null;
      await db
        .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (?, ?, ?, ?, ?)")
        .run(f.id, lipsa, data, "transfer bancar", NOTA_RECONCILIERE);
      platiScrise++;
      sumaScrisa += lipsa;
    }

    let stare = null;
    if (total > 0 && platit + 0.01 >= total) stare = "platita";
    else if (platit > 0.009) stare = "platita_partial";
    if (stare && stare !== f.status) {
      await db.prepare("UPDATE facturi SET status = ? WHERE id = ?").run(stare, f.id);
      statusSchimbat++;
    }
  }

  return {
    potrivite,
    negasite,
    plati_scrise: platiScrise,
    suma_scrisa: Math.round(sumaScrisa * 100) / 100,
    status_schimbat: statusSchimbat,
    exemple_negasite: exemple.slice(0, 10),
  };
}

// Angajati adusi din Conta: contractul de munca e sursa care nu minte pentru
// functie, salariu brut, data angajarii si daca omul mai e in firma. Potrivirea
// se face pe nume normalizat; ce nu se gaseste, se adauga. Nu aducem niciodata
// CNP-ul si nici datele din actul de identitate — nu ne trebuie si nu le vrem.
function numeCheie(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

async function ingestAngajati(randuri) {
  const existenti = await db.prepare("SELECT id, nume, salariu_baza, activ FROM angajati").all();
  const dupaNume = new Map();
  for (const a of existenti) {
    const k = numeCheie(a.nume);
    if (k && !dupaNume.has(k)) dupaNume.set(k, a);
  }

  // pastram un singur contract per om: cel cu data de start cea mai noua
  const peOm = new Map();
  for (const r of randuri) {
    const k = numeCheie(r.nume);
    if (!k) continue;
    const vechi = peOm.get(k);
    if (!vechi || String(r.angajat_din || "") > String(vechi.angajat_din || "")) peOm.set(k, r);
  }

  let adaugati = 0;
  let actualizati = 0;
  let inactivati = 0;
  const noi = [];

  for (const [k, r] of peOm) {
    const activ = r.incetare ? 0 : 1;
    const brut = nr(r.brut);
    const a = dupaNume.get(k);
    if (!a) {
      await db
        .prepare(
          "INSERT INTO angajati (nume, functie, data_angajarii, salariu_baza, sediu, activ, sursa, actualizat_la) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(curat(r.nume), curat(r.functie) || null, r.angajat_din || null, brut, curat(r.locatie) || null, activ, "Conta", acum());
      adaugati++;
      noi.push(curat(r.nume));
      continue;
    }
    await db
      .prepare(
        "UPDATE angajati SET functie = COALESCE(?, functie), data_angajarii = COALESCE(?, data_angajarii), salariu_baza = ?, activ = ?, sursa = ?, actualizat_la = ? WHERE id = ?"
      )
      .run(curat(r.functie) || null, r.angajat_din || null, brut, activ, "Conta", acum(), a.id);
    actualizati++;
    if (a.activ && !activ) inactivati++;
  }

  const total = await db.prepare("SELECT COUNT(*) AS n FROM angajati").get();
  const activi = await db.prepare("SELECT COUNT(*) AS n FROM angajati WHERE activ = 1").get();
  return {
    adaugati,
    actualizati,
    inactivati,
    nume_noi: noi.slice(0, 15),
    angajati_in_erp: Number(total.n || 0),
    activi_acum: Number(activi.n || 0),
  };
}

// Statele de plata lunare, citite din exporturile Conta din Drive. Un rand =
// un om intr-o luna. Daca omul nu e in ERP, il adaugam; daca luna exista deja,
// o rescriem, ca sa se poata rula de cate ori e nevoie fara sa se dubleze.
async function ingestSalarii(randuri) {
  const existenti = await db.prepare("SELECT id, nume FROM angajati").all();
  const dupaNume = new Map();
  for (const a of existenti) {
    const k = numeCheie(a.nume);
    if (k && !dupaNume.has(k)) dupaNume.set(k, a.id);
  }

  let scrise = 0;
  let angajatiNoi = 0;
  const luni = new Set();

  for (const r of randuri) {
    const k = numeCheie(r.nume);
    const luna = String(r.luna || "").slice(0, 7);
    if (!k || !/^\d{4}-\d{2}$/.test(luna)) continue;

    let id = dupaNume.get(k);
    if (!id) {
      const ins = await db
        .prepare("INSERT INTO angajati (nume, functie, salariu_baza, activ, sursa, actualizat_la) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .run(curat(r.nume), curat(r.functie) || null, nr(r.baza), 1, "state de plata", acum());
      id = ins.lastInsertRowid;
      dupaNume.set(k, id);
      angajatiNoi++;
    }

    await db.prepare("DELETE FROM salarii WHERE angajat_id = ? AND luna = ?").run(id, luna);
    await db
      .prepare(
        `INSERT INTO salarii (angajat_id, luna, salariu_brut, bonusuri, deduceri, cas, cass, impozit, salariu_net, platit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, luna, nr(r.brut), nr(r.prime), nr(r.retineri), nr(r.cas), nr(r.cass), nr(r.impozit), nr(r.net), 1);
    scrise++;
    luni.add(luna);
  }

  const total = await db.prepare("SELECT COUNT(*) AS n FROM salarii").get();
  return {
    state_scrise: scrise,
    angajati_noi: angajatiNoi,
    luni: [...luni].sort(),
    state_in_erp: Number(total.n || 0),
  };
}

// Sugestii de clienti noi, din piata. Nu vin din baza noastra: sunt firme
// gasite in afara, cu datele de contact pe care le-am putut aduna. Intra ca
// lead-uri fara agent, deci aceeasi lista pentru toti — cine le ia primul.
// Nu propunem firme pe care le avem deja ca parteneri si nici una de doua ori.
async function ingestSugestii(randuri) {
  const parteneri = await db.prepare("SELECT nume FROM parteneri").all();
  const leaduri = await db.prepare("SELECT nume, companie FROM leaduri").all();
  const stiute = new Set();
  for (const p of parteneri) stiute.add(numeCheie(p.nume));
  for (const l of leaduri) {
    stiute.add(numeCheie(l.nume));
    if (l.companie) stiute.add(numeCheie(l.companie));
  }

  let adaugate = 0;
  let sarite = 0;
  for (const r of randuri) {
    const nume = curat(r.nume) || curat(r.companie);
    const k = numeCheie(nume);
    if (!k || stiute.has(k)) {
      sarite++;
      continue;
    }
    stiute.add(k);
    const detalii = [curat(r.oras), curat(r.site), curat(r.cui) ? `CUI ${curat(r.cui)}` : "", curat(r.adresa)]
      .filter(Boolean)
      .join(" · ");
    await db
      .prepare(
        `INSERT INTO leaduri (nume, companie, email, telefon, sursa, stadiu, partener_id, motiv_sugestie, observatii)
         VALUES (?, ?, ?, ?, 'sugestie', 'nou', NULL, ?, ?)`
      )
      .run(
        nume.slice(0, 200),
        nume.slice(0, 200),
        curat(r.email) || null,
        curat(r.telefon) || null,
        (curat(r.motiv) || "Firmă din piață, posibil consumator de ambalaje.").slice(0, 300),
        detalii.slice(0, 400) || null
      );
    adaugate++;
  }

  const libere = await db
    .prepare("SELECT COUNT(*) AS n FROM leaduri WHERE sursa = 'sugestie' AND atribuit_lui IS NULL AND stadiu <> 'pierdut'")
    .get();
  return { adaugate, sarite, sugestii_libere_acum: Number((libere && libere.n) || 0) };
}

// Incasari pe facturile de vanzare, aduse din raportul SmartBill. Conteaza data
// la care au intrat banii, nu data facturii — de ea atarna comisionul agentului
// si scadentarul. O incasare poate acoperi mai multe facturi ("CSHM2750,
// CSHM2752"): atunci suma se imparte intre ele, proportional cu cat mai au de
// incasat. Dublurile se evita dupa (factura, data, suma), deci se poate rula
// de trei ori pe zi fara sa se adune plati fantoma.
const NOTA_INCASARE = "încasare SmartBill";
// Plăți născocite din statusul facturii, nu din extras: importul vechi le
// scria pe data facturii, cu suma întreagă, doar pentru că SmartBill zicea
// „platită". Când vine încasarea adevărată, cu data ei reală, cele două
// înseamnă același ban de două ori. Aici le recunoaștem ca să le dăm la o
// parte în locul în care apare încasarea adevărată.
const RECONSTITUITE = ["Plată reconstituită automat din statusul din SmartBill", "Încasare adusă prin punte din SmartBill"];

async function ingestIncasari(randuri) {
  const facturi = await db
    .prepare("SELECT id, serie, numar, document_extern FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare' AND status NOT IN ('anulata','ciorna')")
    .all();
  const dupaCheie = new Map();
  const pune = (cheie, id) => {
    const k = String(cheie || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!k) return;
    if (!dupaCheie.has(k)) dupaCheie.set(k, []);
    if (!dupaCheie.get(k).includes(id)) dupaCheie.get(k).push(id);
  };
  for (const f of facturi) {
    pune(`${f.serie || ""}${f.numar || ""}`, f.id);
    if (f.document_extern) pune(f.document_extern, f.id);
  }

  const existente = new Set(
    (await db.prepare("SELECT factura_id, data, suma FROM plati").all()).map(
      (x) => `${x.factura_id}|${String(x.data).slice(0, 10)}|${Number(x.suma).toFixed(2)}`
    )
  );
  // Amprenta randului sursa. Cheia de mai sus nu prinde randurile care
  // listeaza mai multe facturi: suma se imparte dupa soldul ramas, iar soldul
  // se schimba dupa prima trecere, deci a doua oara aceeasi incasare se
  // sparge in alte sume. Amprenta e a randului, nu a bucatii, si nu se
  // schimba oricat de des ar trece puntea peste acelasi raport.
  const amprente = new Set(
    (await db.prepare("SELECT amprenta FROM plati WHERE amprenta IS NOT NULL").all()).map((x) => String(x.amprenta))
  );
  const solduri = new Map(
    (
      await db
        .prepare(
          `SELECT f.id,
                  COALESCE((SELECT SUM(l.cantitate * l.pret_unitar) FROM facturi_linii l WHERE l.factura_id = f.id), 0)
                  - COALESCE((SELECT SUM(pl.suma) FROM (SELECT * FROM plati WHERE activ = 1) pl WHERE pl.factura_id = f.id), 0) AS sold
             FROM (SELECT * FROM facturi WHERE activ = 1) f WHERE f.directie = 'vanzare'`
        )
        .all()
    ).map((x) => [x.id, Number(x.sold) || 0])
  );

  let scrise = 0;
  let surogateSterse = 0;
  let dubluri = 0;
  let negasite = 0;
  const exemple = [];

  for (const r of randuri) {
    const suma = Math.round(nr(r.suma) * 100) / 100;
    const zi = String(r.data || "").slice(0, 10);
    if (!(suma > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(zi)) continue;

    const chei = String(r.factura || "")
      .split(/[,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const tinte = [];
    for (const c of chei) {
      const ids = dupaCheie.get(c.toUpperCase().replace(/[^A-Z0-9]/g, ""));
      if (ids && ids.length) tinte.push(ids[0]);
    }
    if (!tinte.length) {
      negasite++;
      if (exemple.length < 15) exemple.push(String(r.factura || "").slice(0, 60));
      continue;
    }

    const amprenta = `${zi}|${String(r.factura || "").toUpperCase().replace(/[^A-Z0-9,;]/g, "")}|${suma.toFixed(2)}`;
    if (amprente.has(amprenta)) {
      dubluri++;
      continue;
    }
    amprente.add(amprenta);

    // impartirea pe facturi: dupa cat mai are fiecare de incasat; daca nu se
    // stie (facturi fara linii), in parti egale
    const ponderi = tinte.map((id) => Math.max(solduri.get(id) || 0, 0));
    const totalPonderi = ponderi.reduce((a, b) => a + b, 0);
    let ramas = suma;
    for (let i = 0; i < tinte.length; i++) {
      const ultima = i === tinte.length - 1;
      const parte = ultima
        ? Math.round(ramas * 100) / 100
        : Math.round((totalPonderi > 0 ? (suma * ponderi[i]) / totalPonderi : suma / tinte.length) * 100) / 100;
      ramas = Math.round((ramas - parte) * 100) / 100;
      if (!(parte > 0)) continue;
      const amprenta = `${tinte[i]}|${zi}|${parte.toFixed(2)}`;
      if (existente.has(amprenta)) {
        dubluri++;
        continue;
      }
      // Dacă pe factura asta stă deja o plată reconstituită din status, de
      // exact aceeași sumă, ea era doar un surogat pentru încasarea care
      // tocmai a sosit. O ștergem, altfel banul se numără de două ori — așa
      // s-au adunat milioanele de încasări fantomă din anii trecuți.
      // Comparația pe bani se face în JS, nu în SQL: pe Postgres un `?` pus
      // direct într-un ROUND() e ghicit ca întreg și cade cu „invalid input
      // syntax for type integer" la prima sumă cu zecimale.
      const surogate = (
        await db
          .prepare(
            `SELECT id, data, suma FROM (SELECT * FROM plati WHERE activ = 1) plati
              WHERE factura_id = ? AND observatii IN (${RECONSTITUITE.map(() => "?").join(", ")})`
          )
          .all(tinte[i], ...RECONSTITUITE)
      ).filter((v) => Math.round(Number(v.suma) * 100) === Math.round(parte * 100));
      for (const v of surogate) {
        await db.prepare("DELETE FROM plati WHERE id = ?").run(v.id);
        existente.delete(`${tinte[i]}|${String(v.data).slice(0, 10)}|${parte.toFixed(2)}`);
        surogateSterse++;
      }
      await db
        .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii, amprenta) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tinte[i], parte, zi, curat(r.metoda) || "transfer bancar", NOTA_INCASARE, amprenta);
      existente.add(amprenta);
      solduri.set(tinte[i], (solduri.get(tinte[i]) || 0) - parte);
      scrise++;
    }
  }

  return { incasari_scrise: scrise, dubluri_sarite: dubluri, surogate_sterse: surogateSterse, facturi_negasite: negasite, exemple_negasite: exemple.slice(0, 10) };
}

const HANDLERE = {
  produse: ingestProduse,
  stoc: ingestStoc,
  productie: ingestProductie,
  consum: ingestConsum,
  profit_produs: ingestProfitProdus,
  cost_produse: ingestCostProduse,
  facturi: ingestFacturi,
  facturi_linii: ingestFacturiLinii,
  balante: ingestBalante,
  plati_furnizori: ingestPlatiFurnizori,
  angajati: ingestAngajati,
  salarii: ingestSalarii,
  sugestii: ingestSugestii,
  incasari: ingestIncasari,
  registru_comenzi: (randuri) => require("./productie").ingestRegistruComenzi(randuri),
};

function register(router) {
  require("./punte-rute")(router, {
    db,
    esc,
    layout,
    table,
    send,
    redirect,
    HANDLERE,
    acum,
    MAX_OCTETI,
    MAX_RANDURI,
    MAX_LOTURI_PASTRATE,
  });
}

module.exports = { register, HANDLERE };

