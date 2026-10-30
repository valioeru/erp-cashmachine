"use strict";
// Codul scris de voi la produs nou e codul produsului peste tot.
//
// CE A CERUT VALI, 30.10.2026:
//   „Când introducem noi produs, codul introdus de noi rămâne codul peste tot
//    în aplicație."
//
// CE APĂRĂ:
//
//   • UN COD, UN PRODUS. La Produs nou și la Editare, un cod care e deja pe alt
//     produs (activ, neunificat — sau codul generat al altuia) e refuzat, cu
//     numele produsului care îl are. Formularul revine cu ce a scris omul.
//     Codurile duble vechi nu blochează o schimbare de preț.
//
//   • NIMIC NU-L SCHIMBĂ SINGUR. Importul de produse din SmartBill punea codul
//     lor peste al nostru când găsea produsul după denumire. Acum îl
//     completează doar unde lipsește, iar diferențele se numără.
//
//   • PESTE TOT ACELAȘI. Comanda arăta codul generat din caracteristici chiar
//     dacă în fișă fusese schimbat. Acum arată codul din fișă.
//
//   • DUPĂ UNIFICARE, CODUL PĂSTRAT. Paletul din CT-Park, recepția, ieșirea
//     rămâneau pe produsul înghițit; „Produs nou — configurează-l" putea cădea
//     pe produsul dezactivat.
//
// Pe PostgreSQL real (portul 5433), prin rutele adevărate.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
function csv(t) {
  const R = []; let c = "", r = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n") { r.push(c); R.push(r); r = []; c = ""; }
    else if (ch !== "\r") c += ch;
  }
  if (c !== "" || r.length) { r.push(c); R.push(r); }
  return R;
}
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    // UPDATE-urile n-au RETURNING: numărul de rânduri atinse vine din „UPDATE n".
    const s = String(sql);
    if (/^\s*UPDATE/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/UPDATE (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
require(path.join(RAD, "modules", "produse.js")).register(router);
require(path.join(RAD, "modules", "comenzi.js")).register(router);
const { HANDLERE } = require(path.join(RAD, "modules", "punte.js"));
const CP = require(path.join(RAD, "modules", "cod-produs.js"));
const fuziune = require(path.join(RAD, "lib", "produse-fuziune.js"));

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(metoda, cale, params, body) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const formular = (o) => Object.assign({ denumire: "", categorie: "", gestiune: "", unitate_masura: "buc", pret_achizitie: "0", pret_vanzare: "0", cota_tva: "21", stoc_minim: "0" }, o);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const PREFIX = "TST-CPP";
function curata() {
  const ids = q(`SELECT id FROM produse WHERE cod ILIKE '${PREFIX}%' OR cod_generat ILIKE '${PREFIX}%' OR denumire LIKE 'TEST-CPP %'`).map((r) => Number(r.id));
  if (ids.length) {
    const l = ids.join(",");
    q(`DELETE FROM comenzi_linii WHERE produs_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE produs_id IN (${l})`);
    q(`DELETE FROM produse_cod_valori WHERE produs_id IN (${l})`);
    q(`DELETE FROM produse_fuziuni WHERE pastrat_id IN (${l}) OR inghitit_id IN (${l})`);
    q(`UPDATE produse SET fuzionat_in = NULL WHERE id IN (${l})`);
    q(`DELETE FROM produse WHERE id IN (${l})`);
  }
  q(`DELETE FROM comenzi WHERE numar = 'TEST-CPP-1'`);
  q(`DELETE FROM parteneri WHERE nume = 'TEST-CPP Client'`);
}

(async () => {
  curata();
  const produsDupaDenumire = (d) => q("SELECT * FROM produse WHERE denumire = ?", [d])[0] || null;

  console.log("\n1. Produs nou: codul scris rămâne cum l-ați scris");
  {
    const r = await cer("post", "/produse", null, formular({ cod: `  ${PREFIX}-PS5  `, denumire: "TEST-CPP Bandă PET 5mm" }));
    const p = produsDupaDenumire("TEST-CPP Bandă PET 5mm");
    bine("produsul e scris", r.cod === 302 && !!p, r.cod);
    bine("cu codul vostru, fără spațiile de la capete", p && p.cod === `${PREFIX}-PS5`, p && p.cod);
  }

  console.log("\n2. Același cod pe alt produs: refuzat, cu numele celui care îl are");
  {
    const inainte = Number(unul("SELECT COUNT(*) FROM produse"));
    const r = await cer("post", "/produse", null, formular({ cod: `${PREFIX}-ps5`.toLowerCase(), denumire: "TEST-CPP Altă bandă", pret_vanzare: "12,5" }));
    bine("nu se scrie (400)", r.cod === 400, r.cod);
    bine("nimic nou în nomenclator", Number(unul("SELECT COUNT(*) FROM produse")) === inainte);
    bine("mesajul spune pe ce produs e codul", /e deja pe produsul/.test(r.corp) && /TEST-CPP Bandă PET 5mm/.test(r.corp));
    bine("formularul revine cu ce ai scris", /value="TEST-CPP Altă bandă"/.test(r.corp) && /value="12.5"/.test(r.corp));
    bine("literele mici nu fac alt cod", /e deja pe produsul/.test(r.corp));
  }

  console.log("\n3. Un produs unificat sau inactiv nu mai ține codul ocupat");
  {
    q(`INSERT INTO produse (cod, denumire, activ) VALUES ('${PREFIX}-VECHI', 'TEST-CPP Produs inactiv', 0)`);
    const r = await cer("post", "/produse", null, formular({ cod: `${PREFIX}-VECHI`, denumire: "TEST-CPP Produs nou peste cod vechi" }));
    bine("se scrie", r.cod === 302, r.cod);
  }

  console.log("\n4. Codul generat al altui produs e tot ocupat");
  {
    q(`INSERT INTO produse (cod, cod_generat, denumire) VALUES ('${PREFIX}-PROPRIU', '${PREFIX}GEN1', 'TEST-CPP Configurat')`);
    const r = await cer("post", "/produse", null, formular({ cod: `${PREFIX}GEN1`, denumire: "TEST-CPP Scris de mână" }));
    bine("refuzat", r.cod === 400 && /TEST-CPP Configurat/.test(r.corp), r.cod);
  }

  console.log("\n5. Editarea");
  {
    // Două produse cu același cod, ca din importurile vechi.
    q(`INSERT INTO produse (cod, denumire) VALUES ('${PREFIX}-DUBLU', 'TEST-CPP Dublu A'), ('${PREFIX}-DUBLU', 'TEST-CPP Dublu B')`);
    const a = produsDupaDenumire("TEST-CPP Dublu A");
    let r = await cer("post", "/produse/:id/editare", { id: String(a.id) }, formular({ cod: `${PREFIX}-DUBLU`, denumire: "TEST-CPP Dublu A", pret_vanzare: "9" }));
    bine("un cod dublu vechi nu blochează schimbarea prețului", r.cod === 302 && Number(produsDupaDenumire("TEST-CPP Dublu A").pret_vanzare) === 9, r.cod);
    r = await cer("post", "/produse/:id/editare", { id: String(a.id) }, formular({ cod: `${PREFIX}-PS5`, denumire: "TEST-CPP Dublu A", pret_vanzare: "10" }));
    const dupa = produsDupaDenumire("TEST-CPP Dublu A");
    bine("dar mutat pe codul altuia, e refuzat", r.cod === 400 && /TEST-CPP Bandă PET 5mm/.test(r.corp), r.cod);
    bine("și produsul rămâne neatins", dupa.cod === `${PREFIX}-DUBLU` && Number(dupa.pret_vanzare) === 9, dupa.cod + " / " + dupa.pret_vanzare);
    bine("formularul refuzat e tot cel de editare", /action="\/produse\/\d+\/editare"/.test(r.corp));
    r = await cer("post", "/produse/:id/editare", { id: String(a.id) }, formular({ cod: `${PREFIX}-A-NOU`, denumire: "TEST-CPP Dublu A", pret_vanzare: "9" }));
    bine("un cod liber se salvează", r.cod === 302 && produsDupaDenumire("TEST-CPP Dublu A").cod === `${PREFIX}-A-NOU`);
  }

  console.log("\n6. Importul de produse din SmartBill nu schimbă codul nostru");
  {
    q(`INSERT INTO produse (cod, denumire, pret_vanzare) VALUES (NULL, 'TEST-CPP Fără cod', 1)`);
    const rez = await HANDLERE.produse([
      { denumire: "TEST-CPP Bandă PET 5mm", cod: "SB-777", pret_vanzare: "15,5" },
      { denumire: "TEST-CPP Fără cod", cod: `${PREFIX}-DIN-SB`, pret_vanzare: "2" },
      // Același produs, încă o dată, după codul LOR: nu face un produs nou.
      { denumire: "TEST-CPP Bandă PET 5mm (altă denumire)", cod: "SB-777", pret_vanzare: "16" },
    ]);
    const p = produsDupaDenumire("TEST-CPP Bandă PET 5mm");
    bine("codul nostru rămâne", p.cod === `${PREFIX}-PS5`, p.cod);
    bine("prețul se actualizează în continuare", Number(p.pret_vanzare) === 16, p.pret_vanzare);
    bine("unde lipsea, SmartBill îl completează", produsDupaDenumire("TEST-CPP Fără cod").cod === `${PREFIX}-DIN-SB`);
    bine("codul lor duce la același produs, nu la unul nou", !produsDupaDenumire("TEST-CPP Bandă PET 5mm (altă denumire)") && rez.noi === 0, JSON.stringify(rez));
    bine("diferența se vede în rezultat", rez.coduri_pastrate === 2 && /TST-CPP-PS5 \(în SmartBill: SB-777\)/.test(rez.exemple_coduri_pastrate || ""), JSON.stringify(rez));
  }

  console.log("\n7. Comanda arată codul din fișă, nu pe cel generat");
  {
    const conf = produsDupaDenumire("TEST-CPP Configurat");
    const part = Number(q("INSERT INTO parteneri (nume) VALUES ('TEST-CPP Client') RETURNING id")[0].id);
    const com = Number(q(`INSERT INTO comenzi (partener_id, numar, data) VALUES (${part}, 'TEST-CPP-1', '2026-10-30') RETURNING id`)[0].id);
    q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${com}, ${conf.id}, 3, 10)`);
    const r = await cer("get", "/comenzi/:id", { id: String(com) });
    bine("comanda se deschide", r.cod === 200, r.cod);
    bine(`pe linie scrie ${PREFIX}-PROPRIU`, r.corp.includes(`${PREFIX}-PROPRIU`));
    bine("nu codul generat", !r.corp.includes(`${PREFIX}GEN1`));
  }

  console.log("\n8. După unificare: codul păstrat, peste tot");
  {
    const pastrat = produsDupaDenumire("TEST-CPP Bandă PET 5mm");
    const inghitit = produsDupaDenumire("TEST-CPP Configurat");
    const palet = Number(unul("SELECT id FROM ct_paleti ORDER BY id LIMIT 1") || 0);
    if (palet) q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um) VALUES (${palet}, ${inghitit.id}, 'TEST-CPP linie', 5, 'buc')`);
    await fuziune.fuzioneaza(pastrat.id, [inghitit.id], 1);
    if (palet) {
      const pe = unul(`SELECT produs_id FROM ct_palet_linii WHERE produs_text = 'TEST-CPP linie'`);
      bine("linia paletului din CT-Park trece pe produsul păstrat", Number(pe) === Number(pastrat.id), pe);
    } else {
      bine("(nu e niciun palet în baza de test — sar peste linia de palet)", true);
    }
    const gasit = await CP.produsulCodului(`${PREFIX}GEN1`);
    bine("codul generat al celui înghițit duce la cel păstrat, nu la cel dezactivat", gasit && Number(gasit.id) === Number(pastrat.id), JSON.stringify(gasit));
    const r = await cer("post", "/produse", null, formular({ cod: `${PREFIX}-PROPRIU`, denumire: "TEST-CPP Pe codul celui înghițit" }));
    bine("codul celui înghițit nu mai e ocupat", r.cod === 302, r.cod);
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
