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
      // nu ștergem un preț existent cu zero — importul poate veni parțial
      await db
        .prepare(
          `UPDATE produse SET cod = COALESCE(NULLIF(?, ''), cod),
                              unitate_masura = COALESCE(NULLIF(?, ''), unitate_masura),
                              pret_vanzare = CASE WHEN ? > 0 THEN ? ELSE pret_vanzare END,
                              pret_achizitie = CASE WHEN ? > 0 THEN ? ELSE pret_achizitie END,
                              cota_tva = CASE WHEN ? > 0 THEN ? ELSE cota_tva END
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

const HANDLERE = {
  produse: ingestProduse,
  stoc: ingestStoc,
  productie: ingestProductie,
  consum: ingestConsum,
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

