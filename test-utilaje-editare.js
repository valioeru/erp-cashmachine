"use strict";
// Fisa utilajului se poate corecta din ERP. Pe PostgreSQL real (prin psql).
//
// DE CE CONTEAZA: fisa a intrat dintr-un Excel, dar din momentul asta ERP-ul
// e originalul, nu copia. Cineva masoara in atelier si vede ca grosimea
// maxima nu e 100, e 120. Daca nu poate scrie asta aici, o sa trimita un mail
// si o sa astepte — sau, mai rau, o sa tina minte si n-o sa stie nimeni.
//
// CE APARA:
//
//   • CAMPUL GOL E "NU STIU", NU ZERO. Un consum de 0 kW si unul necunoscut
//     arata la fel intr-o coloana, dar pe primul poti planifica si pe al
//     doilea nu.
//
//   • CORECTURA SUPRAVIETUIESTE REPORNIRII. Seed-ul ruleaza la fiecare
//     pornire; daca ar rescrie, corectura ar tine pana la primul redeploy.
//
//   • CAPACITATEA DECLARATA BATE CALCULUL. Cand omul scrie cat scoate masina
//     de fapt, aia devine capacitatea de plan — include pierderile pe care
//     calculul nu le stie.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
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

const S = require(path.join(RAD, "lib", "utilaje-seed.js"));
const mod = require(path.join(RAD, "modules", "utilaje.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: VALI, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 220) : "")); esecuri++; }
}

function curata() {
  for (const t of ["utilaje_parametri", "utilaje_setup", "utilaje_consumabile", "utilaje_rute",
                   "fluxuri_pasi", "fluxuri", "cilindri_flexo", "utilaje_reguli"]) q("DELETE FROM " + t);
  q("DELETE FROM utilaje WHERE cod ~ '^UT[0-9]+$'");
}

(async () => {
  curata();
  await S.seed();
  const ut01 = Number(unul("SELECT id FROM utilaje WHERE cod = 'UT01'"));

  console.log("\n1. Capul fisei se poate corecta tot, nu doar codul si denumirea");
  {
    await cer("/productie/utilaje/:id", {
      metoda: "post", params: { id: String(ut01) },
      body: {
        cod: "UT01", denumire: "Extruder", activ: "1", ore_pe_zi: "24",
        categorie: "Extrudare suflare", regim_lucru: "NON-STOP",
        timp_disponibil_schimb_min: "470", schimburi_zi: "3",
        operatori_necesari: "2", nr_helperi: "1",
        consum_kw: "210", consum_alt: "120 kWh încălzire", status_date: "COMPLET",
        scop: "Folie suflată", observatii: "verificat în atelier",
      },
    });
    const u = q("SELECT * FROM utilaje WHERE id = " + ut01)[0];
    bine("categoria", u.categorie === "Extrudare suflare");
    bine("minutele pe schimb", Number(u.timp_disponibil_schimb_min) === 470, u.timp_disponibil_schimb_min);
    bine("helperii, separat de operatori", Number(u.nr_helperi) === 1 && Number(u.operatori_necesari) === 2);
    bine("consumul", Number(u.consum_kw) === 210 && /încălzire/.test(u.consum_alt));
    bine("observatia", u.observatii === "verificat în atelier");
  }

  console.log("\n2. Câmpul gol înseamnă „nu știu”, nu zero");
  {
    await cer("/productie/utilaje/:id", {
      metoda: "post", params: { id: String(ut01) },
      body: { cod: "UT01", denumire: "Extruder", activ: "1", consum_kw: "", nr_helperi: "", timp_disponibil_schimb_min: "" },
    });
    const u = q("SELECT consum_kw, nr_helperi, timp_disponibil_schimb_min FROM utilaje WHERE id = " + ut01)[0];
    bine("consumul golit e NULL, nu 0", u.consum_kw === null, JSON.stringify(u));
    bine("helperii la fel", u.nr_helperi === null);
    bine("si minutele pe schimb", u.timp_disponibil_schimb_min === null);
  }

  console.log("\n3. Un parametru se poate corecta");
  {
    const p = q("SELECT id, valoare_num FROM utilaje_parametri WHERE utilaj_id = " + ut01 + " AND parametru_cod = 'grosime_max'")[0];
    bine("pornim de la 100 µm", Number(p.valoare_num) === 100);
    await cer("/productie/utilaje/:id/parametru", {
      metoda: "post", params: { id: String(ut01) },
      body: { parametru_id: String(p.id), parametru: "Grosime folie max.", valoare_num: "120", unitate: "µm", sursa: "CORECTAT", confirmat: "DA", observatii: "măsurat 21.10" },
    });
    const d = q("SELECT * FROM utilaje_parametri WHERE id = " + p.id)[0];
    bine("acum e 120", Number(d.valoare_num) === 120, d.valoare_num);
    bine("si scrie cine zice asta", d.sursa === "CORECTAT" && /măsurat/.test(d.observatii));
    bine("codul nu s-a schimbat, deci seed-ul il recunoaste", d.parametru_cod === "grosime_max");

    // Asta e tot rostul: la urmatoarea pornire, corectura ramane.
    await S.seed();
    bine("si supravietuieste repornirii", Number(unul("SELECT valoare_num FROM utilaje_parametri WHERE id = " + p.id)) === 120);
  }

  console.log("\n4. Un parametru nou, scris de om");
  {
    const inainte = Number(unul("SELECT count(*) FROM utilaje_parametri WHERE utilaj_id = " + ut01));
    await cer("/productie/utilaje/:id/parametru", {
      metoda: "post", params: { id: String(ut01) },
      body: { parametru: "Lățime maximă balon", valoare_num: "1600", unitate: "mm", sursa: "DECLARAT" },
    });
    const n = q("SELECT * FROM utilaje_parametri WHERE utilaj_id = " + ut01 + " ORDER BY id DESC LIMIT 1")[0];
    bine("s-a adaugat", Number(unul("SELECT count(*) FROM utilaje_parametri WHERE utilaj_id = " + ut01)) === inainte + 1);
    // Codul se face singur din denumire: omul nu trebuie sa inventeze chei.
    bine("codul se face singur din denumire", n.parametru_cod === "latime_maxima_balon", n.parametru_cod);
    bine("cu valoarea scrisa", Number(n.valoare_num) === 1600);

    // Acelasi parametru scris a doua oara nu face dublura.
    await cer("/productie/utilaje/:id/parametru", {
      metoda: "post", params: { id: String(ut01) },
      body: { parametru: "Lățime maximă balon", valoare_num: "1700", unitate: "mm" },
    });
    bine("scris a doua oara nu face dublura", Number(unul("SELECT count(*) FROM utilaje_parametri WHERE utilaj_id = " + ut01)) === inainte + 1);
    bine("ci actualizeaza", Number(unul("SELECT valoare_num FROM utilaje_parametri WHERE id = " + n.id)) === 1700);

    await cer("/productie/utilaje/:id/parametru/:pid/sterge", { metoda: "post", params: { id: String(ut01), pid: String(n.id) } });
    bine("si se poate sterge", Number(unul("SELECT count(*) FROM utilaje_parametri WHERE utilaj_id = " + ut01)) === inainte);
  }

  console.log("\n5. Timpii de setup");
  {
    const ut03 = Number(unul("SELECT id FROM utilaje WHERE cod = 'UT03'"));
    const s = q("SELECT * FROM utilaje_setup WHERE utilaj_id = " + ut03 + " AND eveniment_cod = 'SCHIMB_JUMBO'")[0];
    await cer("/productie/utilaje/:id/setup", {
      metoda: "post", params: { id: String(ut03) },
      body: { setup_id: String(s.id), descriere: "Schimbare jumbo", durata_min: "5", frecventa: "PER_ROLA", interval_valoare: "50", interval_unitate: "kg" },
    });
    const d = q("SELECT * FROM utilaje_setup WHERE id = " + s.id)[0];
    bine("durata se schimba", Number(d.durata_min) === 5, d.durata_min);
    bine("si intervalul", Number(d.interval_valoare) === 50 && d.interval_unitate === "kg");

    await cer("/productie/utilaje/:id/setup", {
      metoda: "post", params: { id: String(ut03) },
      body: { descriere: "Curățare filieră", durata_min: "25", frecventa: "PER_SCHIMB" },
    });
    const n = q("SELECT * FROM utilaje_setup WHERE utilaj_id = " + ut03 + " ORDER BY id DESC LIMIT 1")[0];
    bine("un timp nou se adauga", n.descriere === "Curățare filieră" && Number(n.durata_min) === 25);
    bine("cu cod facut din denumire", n.eveniment_cod === "CURATARE_FILIERA", n.eveniment_cod);
  }

  console.log("\n6. Capacitatea declarată bate calculul");
  {
    const r = q("SELECT * FROM utilaje_rute WHERE utilaj_id = " + ut01 + " LIMIT 1")[0];
    bine("la inceput planul e cel calculat", Number(r.capacitate_plan_schimb) === Number(r.capacitate_calculata_schimb), r.capacitate_plan_schimb + " / " + r.capacitate_calculata_schimb);
    await cer("/productie/utilaje/:id/ruta/:rid", {
      metoda: "post", params: { id: String(ut01), rid: String(r.id) },
      body: { capacitate_declarata_schimb: "760", observatii: "măsurat trei schimburi" },
    });
    const d = q("SELECT * FROM utilaje_rute WHERE id = " + r.id)[0];
    bine("ce a masurat omul se scrie", Number(d.capacitate_declarata_schimb) === 760);
    bine("si devine capacitatea de plan", Number(d.capacitate_plan_schimb) === 760, d.capacitate_plan_schimb);
    bine("calculul ramane, ca sa se vada diferenta", Number(d.capacitate_calculata_schimb) === Number(r.capacitate_calculata_schimb));

    // Sters din casuta, planul se intoarce la calcul — nu ramane agatat.
    await cer("/productie/utilaje/:id/ruta/:rid", {
      metoda: "post", params: { id: String(ut01), rid: String(r.id) },
      body: { capacitate_declarata_schimb: "" },
    });
    const g = q("SELECT * FROM utilaje_rute WHERE id = " + r.id)[0];
    bine("golit, planul se intoarce la calcul", Number(g.capacitate_plan_schimb) === Number(g.capacitate_calculata_schimb), g.capacitate_plan_schimb);
  }

  console.log("\n7. Consumabile");
  {
    const c = q("SELECT * FROM utilaje_consumabile WHERE utilaj_id = " + ut01 + " LIMIT 1")[0];
    await cer("/productie/utilaje/:id/consumabil", {
      metoda: "post", params: { id: String(ut01) },
      body: { consumabil_id: String(c.id), tip: "SCULA", denumire: "Filieră 1.500 mm", observatii: "două bucăți" },
    });
    const d = q("SELECT * FROM utilaje_consumabile WHERE id = " + c.id)[0];
    bine("se modifica", d.denumire === "Filieră 1.500 mm" && d.tip === "SCULA");
    await cer("/productie/utilaje/:id/consumabil/:cid/sterge", { metoda: "post", params: { id: String(ut01), cid: String(c.id) } });
    bine("si se sterge", Number(unul("SELECT count(*) FROM utilaje_consumabile WHERE id = " + c.id)) === 0);
  }

  console.log("\n8. Pagina se deschide si arata casutele");
  {
    const p = await cer("/productie/utilaje/:id", { params: { id: String(ut01) } });
    bine("pagina raspunde", p.cod === 200);
    bine("capul fisei are casute, nu doar text", /name="timp_disponibil_schimb_min"/.test(p.corp) && /name="consum_kw"/.test(p.corp));
    bine("parametrii au fiecare formularul lui", /id="par-\d+"/.test(p.corp));
    bine("rutele la fel", /id="ruta-\d+"/.test(p.corp));
    // UT01 n-are timpi de setup in fisa. Sectiunea tot trebuie sa ofere
    // adaugarea — altfel un utilaj care porneste gol ramane gol pe veci,
    // fiindca n-are de unde sa i se scrie primul rand.
    bine("un utilaj fara timpi de setup tot poate primi unul", /Adaugă un timp/.test(p.corp));
    bine("si se vede ca n-are niciunul", /Timpi de setup[\s\S]{0,120}niciunul încă/.test(p.corp));
    bine("formularele de adaugare sunt acolo", /Adaugă un parametru/.test(p.corp) && /Adaugă un consumabil/.test(p.corp));

    // Iar unde EXISTA timpi, fiecare rand are formularul lui.
    const ut02 = Number(unul("SELECT id FROM utilaje WHERE cod = 'UT02'"));
    const p2 = await cer("/productie/utilaje/:id", { params: { id: String(ut02) } });
    bine("la un utilaj cu timpi, fiecare rand are formularul lui", /id="set-\d+"/.test(p2.corp));
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
