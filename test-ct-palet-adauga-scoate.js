"use strict";
// Adaugă / scoate marfă de pe un palet care stă deja în raft.
//
// CE A CERUT VALI, 30.10.2026:
//   „Trebuie să pot edita marfa de pe rafturi, să pot adăuga sau lua din ea —
//    când dau click pe ea, să adaug marfă sau să scot."
//
// CE APĂRĂ:
//
//   • ADAUGĂ. Cât se pune în plus pe fiecare linie; fără preț scris, același
//     preț; cu alt preț, media ponderată (valoarea paletului rămâne suma).
//     „Alt produs pe palet" se caută după codul vostru, apoi după denumire;
//     altfel rămâne scris liber. Fiecare adăugare are urmă: cine, când, cât.
//
//   • SCOATE. Cât pleacă + cât rămâne = cât e în sistem (regula depozitului,
//     CPL.validareIesire). Destinația e obligatorie. Costul iese cu prețul
//     paletului. Paletul golit iese din depozit și eliberează locul; altfel
//     stă pe loc, cu locurile lui.
//
//   • NIMIC PE JUMĂTATE. O cerere greșită nu schimbă nimic.
//
// Partea întâi pe regula pură, a doua pe PostgreSQL real (portul 5433).
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
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const CPL = require(path.join(RAD, "lib", "ct-palet-linii.js"));
const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "ct-park.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(metoda, cale, params, body, query) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: query || {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => decodeURIComponent(String((r.antet && (r.antet.Location || r.antet.location)) || ""));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const NUMAR = 97;
const MARCAJ = "TEST-PAS palet de test";
function curata() {
  const paleti = q(`SELECT id FROM ct_paleti WHERE observatii = ${lit(MARCAJ)}`).map((r) => Number(r.id));
  if (paleti.length) {
    const l = paleti.join(",");
    q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${l}))`);
    q(`DELETE FROM ct_iesiri WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_adaugari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${l})`);
  }
  const r = unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`);
  if (r) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q(`DELETE FROM comenzi WHERE numar = 'TEST-PAS-CMD'`);
  q(`DELETE FROM parteneri WHERE nume = 'TEST-PAS Client'`);
  q(`DELETE FROM produse WHERE cod IN ('TST-PAS-1', 'TST-PAS-2')`);
}

(async () => {
  // ======================================================================
  console.log("\n1. Regula de adăugare (pură)");
  {
    const linie = { id: 7, produs_text: "Folie", cantitate: 100, um: "kg", pret_unitar: 7, pret_sursa: "scris la intrare" };
    let v = CPL.validareAdaugare([linie], { 7: { cantitate: "50", pret: "10" } });
    bine("alt preț: media ponderată (100×7 + 50×10) / 150 = 8", v.actualizate && v.actualizate[0].cantitate === 150 && Math.abs(v.actualizate[0].pret_unitar - 8) < 1e-9, JSON.stringify(v));
    bine("și scrie de unde e prețul", v.actualizate && v.actualizate[0].pret_sursa === "medie după adăugare");
    v = CPL.validareAdaugare([linie], { 7: { cantitate: "12,5" } });
    bine("fără preț: același preț, cantitatea cu virgulă", v.actualizate[0].cantitate === 112.5 && v.actualizate[0].pret_unitar === 7 && v.actualizate[0].pret_sursa === "scris la intrare", JSON.stringify(v));
    v = CPL.validareAdaugare([{ ...linie, pret_unitar: null, pret_sursa: null }], { 7: { cantitate: "10", pret: "5" } });
    bine("linia fără preț ia prețul scris acum", v.actualizate[0].pret_unitar === 5 && v.actualizate[0].pret_sursa === "scris la adăugare", JSON.stringify(v));
    v = CPL.validareAdaugare([linie], { 7: { cantitate: "-5" } });
    bine("minus: trimite la „Scoate”", /Scoate/.test(v.eroare || ""), v.eroare);
    v = CPL.validareAdaugare([linie], { 7: { pret: "9" } });
    bine("preț fără cantitate: refuzat", /nu si cat adaugi/.test(v.eroare || ""), v.eroare);
    v = CPL.validareAdaugare([linie], {}, {});
    bine("nimic scris: refuzat", /N-ai scris nicio cantitate/.test(v.eroare || ""), v.eroare);
    v = CPL.validareAdaugare([linie], {}, { cantitate: "3" });
    bine("alt produs fără nume: refuzat", /ce produs e/.test(v.eroare || ""), v.eroare);
    v = CPL.validareAdaugare([linie], {}, { produs: "Bandă", cantitate: "" });
    bine("alt produs fără cantitate: refuzat", /scrie cat pui/.test(v.eroare || ""), v.eroare);
    v = CPL.validareAdaugare([linie], {}, { produs: " Bandă ", cantitate: "3", um: "rol", pret: "2,5" });
    bine("alt produs bun", v.nou && v.nou.produs === "Bandă" && v.nou.cantitate === 3 && v.nou.um === "rol" && v.nou.pret_unitar === 2.5, JSON.stringify(v));
  }

  // ======================================================================
  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'rand test adauga-scoate', 2, 1, 3, 800, 1200, 1)`);
  const rand = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`));
  for (let camp = 1; camp <= 2; camp++)
    for (let poz = 1; poz <= 3; poz++)
      q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rand}, 1, ${camp}, ${poz}, 'TA-${camp}-1-${poz}', 0)`);
  const loc = (c, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=${c} AND pozitie=${p}`));
  const p1 = Number(q(`INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-PAS-1', 'TEST-PAS Folie', 'kg') RETURNING id`)[0].id);
  const p2 = Number(q(`INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-PAS-2', 'TEST-PAS Bandă', 'kg') RETURNING id`)[0].id);
  const palet = Number(
    q(`INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, um, categorie, data_intrare, observatii, creat_de, pret_unitar, pret_sursa)
       VALUES ('CTTEST-PAS', ${p1}, 'TEST-PAS Folie', 100, 'kg', 'materie primă', '2026-10-30', ${lit(MARCAJ)}, 'Vali', 7, 'scris la intrare') RETURNING id`)[0].id
  );
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar, pret_sursa) VALUES (${palet}, ${p1}, 'TEST-PAS Folie', 100, 'kg', 7, 'scris la intrare')`);
  q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet}, ${loc(1, 1)}), (${palet}, ${loc(1, 2)})`);
  const l1 = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${palet} ORDER BY id LIMIT 1`));
  const P = () => q(`SELECT * FROM ct_paleti WHERE id = ${palet}`)[0];
  const linii = () => q(`SELECT * FROM ct_palet_linii WHERE palet_id = ${palet} ORDER BY id`);
  const nrIesiri = () => Number(unul(`SELECT COUNT(*) FROM ct_iesiri WHERE palet_id = ${palet}`));
  const nrOcupari = () => Number(unul(`SELECT COUNT(*) FROM ct_ocupari WHERE palet_id = ${palet}`));

  console.log("\n2. Pagina paletului (click pe hartă): Adaugă și Scoate, sus");
  {
    const r = await cer("get", "/stocuri/ct-park/palet/:id", { id: String(palet) });
    bine("se deschide", r.cod === 200, r.cod);
    bine("formularul „Adaugă”, cu câmp pe linia paletului", r.corp.includes(`action="/stocuri/ct-park/palet/${palet}/adauga"`) && r.corp.includes(`name="adauga_${l1}"`));
    bine("formularul „Scoate”, cu „pleacă” și „rămâne”", r.corp.includes(`action="/stocuri/ct-park/palet/${palet}/scoate-partial"`) && r.corp.includes(`name="pleaca_${l1}"`) && r.corp.includes(`name="ramane_${l1}"`));
    bine("cu destinațiile ieșirii", /name="destinatie" value="productie"/.test(r.corp) && /name="destinatie" value="comanda"/.test(r.corp));
    bine("formularele stau înaintea fișei", r.corp.indexOf("Adaugă marfă pe palet") < r.corp.indexOf('class="detail-box"'));
  }

  console.log("\n3. Adaugă pe linia existentă, cu alt preț");
  {
    const r = await cer("post", "/stocuri/ct-park/palet/:id/adauga", { id: String(palet) }, { [`adauga_${l1}`]: "50", [`pret_${l1}`]: "10", observatii: "de la furnizor" });
    const l = linii()[0];
    bine("înapoi pe palet, cu mesaj", /palet\/\d+\?ok=Adăugat pe palet/.test(locatie(r)), locatie(r));
    bine("linia: 150 kg la 8 lei (media)", Number(l.cantitate) === 150 && Math.abs(Number(l.pret_unitar) - 8) < 1e-6, JSON.stringify(l));
    const p = P();
    bine("paletul (harta, eticheta) arată 150, prețul 8, de unde e", Number(p.cantitate) === 150 && Math.abs(Number(p.pret_unitar) - 8) < 1e-6 && p.pret_sursa === "medie după adăugare", JSON.stringify([p.cantitate, p.pret_unitar, p.pret_sursa]));
    const a = q(`SELECT * FROM ct_palet_adaugari WHERE palet_id = ${palet}`);
    bine("urma: cine, cât, cu ce preț", a.length === 1 && Number(a[0].cantitate) === 50 && Number(a[0].pret_unitar) === 10 && a[0].creat_de === "Vali" && a[0].observatii === "de la furnizor", JSON.stringify(a));
  }

  console.log("\n4. Alt produs pe palet: după codul vostru, apoi scris liber");
  {
    let r = await cer("post", "/stocuri/ct-park/palet/:id/adauga", { id: String(palet) }, { nou_produs: "tst-pas-2", nou_cantitate: "20" });
    let L = linii();
    const nou = L.find((x) => Number(x.produs_id) === p2);
    bine("găsit după cod (și cu litere mici), legat de produs", !!nou && Number(nou.cantitate) === 20 && nou.um === "kg", JSON.stringify(L));
    const p = P();
    bine("paletul devine mixt: 170 kg, „2 produse”", Number(p.cantitate) === 170 && p.produs_id === null && /^2 produse: TEST-PAS Folie, TEST-PAS Bandă/.test(p.produs_text || ""), JSON.stringify([p.cantitate, p.produs_id, p.produs_text]));
    r = await cer("post", "/stocuri/ct-park/palet/:id/adauga", { id: String(palet) }, { nou_produs: "ceva scris liber", nou_cantitate: "3", nou_um: "kg" });
    L = linii();
    bine("ce nu se găsește rămâne scris liber", L.some((x) => x.produs_id === null && x.produs_text === "ceva scris liber" && Number(x.cantitate) === 3), JSON.stringify(L));
    bine("mesajul spune că e scris liber", /scris liber/.test(locatie(r)), locatie(r));
  }

  console.log("\n5. Scoate: ce e greșit nu schimbă nimic");
  {
    const inainte = JSON.stringify(linii());
    let r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, { [`pleaca_${l1}`]: "50", [`ramane_${l1}`]: "100" });
    bine("fără destinație: refuzat", /eroare=Alege unde se duce/.test(locatie(r)), locatie(r));
    r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, { destinatie: "productie", [`pleaca_${l1}`]: "10", [`ramane_${l1}`]: "100" });
    bine("cifre care nu se închid (10 + 100 ≠ 150): refuzat", /Nu se inchide/.test(locatie(r)), locatie(r));
    r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, { destinatie: "productie", [`pleaca_${l1}`]: "50" });
    bine("fără „rămâne”: refuzat", /cat ramane/.test(locatie(r)), locatie(r));
    r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, { destinatie: "comanda", [`pleaca_${l1}`]: "50", [`ramane_${l1}`]: "100" });
    bine("comandă fără comanda aleasă: refuzat", /trebuie aleasă exact comanda/.test(locatie(r)), locatie(r));
    bine("nimic schimbat, nicio ieșire scrisă", JSON.stringify(linii()) === inainte && nrIesiri() === 0);
  }

  console.log("\n6. Scoate o parte: paletul stă pe loc");
  {
    const r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, { destinatie: "productie", [`pleaca_${l1}`]: "50", [`ramane_${l1}`]: "100" });
    const l = linii().find((x) => Number(x.id) === l1);
    bine("linia: rămân 100", Number(l.cantitate) === 100, l.cantitate);
    const ies = q(`SELECT * FROM ct_iesiri WHERE palet_id = ${palet}`);
    bine("ieșire parțială spre producție, cost 50 × 8 = 400 lei", ies.length === 1 && Number(ies[0].partiala) === 1 && ies[0].destinatie === "productie" && Math.abs(Number(ies[0].cost) - 400) < 0.01, JSON.stringify(ies));
    bine("cu adresa de unde a plecat", ies.length === 1 && ies[0].adresa === "TA-1-1-1 + TA-1-1-2", ies[0] && ies[0].adresa);
    const il = q(`SELECT * FROM ct_iesiri_linii WHERE iesire_id = ${ies[0].id}`);
    bine("linia ieșirii: 50 plecate, 100 numărate rămase", il.length === 1 && Number(il[0].cantitate) === 50 && Number(il[0].cantitate_ramasa) === 100);
    const p = P();
    bine("paletul e tot în depozit, pe aceleași două locuri", !p.data_iesire && nrOcupari() === 2);
    bine("rezumatul scade: 100 + 20 + 3 = 123 kg", Number(p.cantitate) === 123, p.cantitate);
    bine("mesajul spune cât a plecat și cât rămâne", /A plecat 50 kg TEST-PAS Folie spre producție/.test(locatie(r)) && /rămân 123/.test(locatie(r)), locatie(r));
  }

  console.log("\n7. Scoate tot: paletul iese și locul se eliberează");
  {
    const part = Number(q("INSERT INTO parteneri (nume) VALUES ('TEST-PAS Client') RETURNING id")[0].id);
    const com = Number(q(`INSERT INTO comenzi (partener_id, numar, data) VALUES (${part}, 'TEST-PAS-CMD', '2026-10-30') RETURNING id`)[0].id);
    const body = { destinatie: "comanda", comanda_id: String(com) };
    for (const l of linii().filter((x) => Number(x.cantitate) > 0)) { body["pleaca_" + l.id] = String(l.cantitate); body["ramane_" + l.id] = "0"; }
    const inainte = P();
    const r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", { id: String(palet) }, body);
    const p = P();
    bine("paletul a ieșit", !!p.data_iesire, p.data_iesire);
    bine("locurile sunt libere", nrOcupari() === 0);
    const ies = q(`SELECT * FROM ct_iesiri WHERE palet_id = ${palet} ORDER BY id DESC LIMIT 1`)[0];
    bine("ieșirea e întreagă, pe comanda aleasă", Number(ies.partiala) === 0 && ies.comanda_numar === "TEST-PAS-CMD" && ies.client === "TEST-PAS Client", JSON.stringify(ies));
    bine("fișa paletului ieșit își păstrează rezumatul (istoric)", Number(p.cantitate) === Number(inainte.cantitate) && p.produs_text === inainte.produs_text);
    bine("mesajul spune că locul e liber", /a ieșit din depozit/.test(locatie(r)) && /TA-1-1-1 \+ TA-1-1-2 e liber/.test(locatie(r)), locatie(r));
  }

  console.log("\n8. Pe un palet ieșit nu se mai adaugă");
  {
    const r = await cer("post", "/stocuri/ct-park/palet/:id/adauga", { id: String(palet) }, { [`adauga_${l1}`]: "5" });
    bine("refuzat", /eroare=Paletul a ieșit/.test(locatie(r)), locatie(r));
    const g = await cer("get", "/stocuri/ct-park/palet/:id", { id: String(palet) });
    bine("iar pagina lui nu mai are formularele", g.cod === 200 && !g.corp.includes("/adauga\"") && !g.corp.includes("scoate-partial"));
  }

  console.log("\n9. Mesajele ajung pe pagină");
  {
    const g = await cer("get", "/stocuri/ct-park/palet/:id", { id: String(palet) }, null, { ok: "Totul bine <b>", eroare: "Ceva rău" });
    bine("ok și eroare, scăpate", g.corp.includes("Totul bine &lt;b&gt;") && g.corp.includes("flash flash-rosu"));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
