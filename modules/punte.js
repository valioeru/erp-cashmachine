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

  const produse = new Map();
  for (const p of await db.prepare("SELECT id, cod, denumire, pret_achizitie FROM produse").all()) {
    produse.set(String(p.denumire).trim().toLowerCase(), p.id);
    if (p.cod) produse.set(String(p.cod).trim().toLowerCase(), p.id);
  }

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
        .prepare("SELECT id FROM facturi WHERE directie = 'vanzare' AND UPPER(COALESCE(serie,'')) = ? AND numar = ? ORDER BY id LIMIT 1")
        .get(serie, numar);
    }
    if (!f) {
      f = await db
        .prepare("SELECT id FROM facturi WHERE directie = 'vanzare' AND REPLACE(UPPER(COALESCE(document_extern,'')), ' ', '') = ? ORDER BY id LIMIT 1")
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
      const produsId =
        (cod && produse.get(cod.toLowerCase())) || produse.get(denumire.toLowerCase()) || null;
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
    // verificarea care contează: venituri minus cheltuieli, cum îl arată dashboard-ul
    const v = linii.filter((c) => c.cont.startsWith("7")).reduce((s, c) => s + (nr(c.ts_c) - nr(c.ts_d)), 0);
    const ch = linii.filter((c) => c.cont.startsWith("6")).reduce((s, c) => s + (nr(c.ts_d) - nr(c.ts_c)), 0);
    detalii.push(`${eticheta}: ${linii.length} conturi, profit ${Math.round(v - ch).toLocaleString("ro-RO")} lei`);
    etichete++;
    conturi += linii.length;
  }

  return {
    rezumat: `${etichete} ${etichete === 1 ? "balanță" : "balanțe"}, ${conturi} rânduri de cont`,
    detalii,
  };
}

const HANDLERE = {
  produse: ingestProduse,
  stoc: ingestStoc,
  productie: ingestProductie,
  consum: ingestConsum,
  profit_produs: ingestProfitProdus,
  facturi_linii: ingestFacturiLinii,
  balante: ingestBalante,
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

