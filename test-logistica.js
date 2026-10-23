"use strict";
// Paginile de logistică, pe PostgreSQL real (prin psql — vezi test-depozit.js
// pentru de ce). Din rădăcina repo-ului, cu baza pornită pe 127.0.0.1:5433.
//
// Regulile de calcul au testele lor în test-transport-cost.js. Aici se
// verifică altceva: că paginile chiar citesc din bază ce trebuie, că
// alocarea scrie ce trebuie, și mai ales CELE DOUĂ LUCRURI CARE SE STRICĂ
// TĂCUT:
//
//   • alocarea unei mașini proprii TREBUIE să-i pună și rezervarea. Fără ea,
//     a doua cursă din aceeași zi o vede liberă și o alocă din nou. Nimeni
//     nu află până dimineața, în rampă.
//
//   • dezalocarea TREBUIE să rupă rezervarea. Altfel mașina rămâne ocupată
//     pentru o cursă care nu mai e a ei, și dispare din clasamente degeaba.
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

const mod = require(path.join(RAD, "modules", "logistica.js"));
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

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const ZI = 86400000;
const azi = new Date().toISOString().slice(0, 10);
const peste3 = new Date(Date.now() + 3 * ZI).toISOString().slice(0, 10);
const peste20 = new Date(Date.now() + 20 * ZI).toISOString().slice(0, 10);

(async () => {
  // Curatenie inainte SI dupa. Nu doar ca testul sa poata rula de doua ori:
  // daca lasa in urma un partener si o comanda, fixtura lui test-depozit.js
  // nu mai poate goli tabelul „parteneri" si pica ACOLO — adica stric un test
  // care n-are nicio legatura cu mine, iar cine il vede rosu maine cauta
  // problema in depozit.
  const curata = () => {
    q("DELETE FROM transport_rezervari");
    q("DELETE FROM transport_curse");
    q("DELETE FROM transport_tarife");
    q("DELETE FROM transport_oferte");
    q("DELETE FROM transportatori");
    q("DELETE FROM transport_distante");
    q("DELETE FROM comenzi WHERE numar = 'CMD-991'");
    q("DELETE FROM parteneri WHERE nume = 'Gata SRL'");
  };
  curata();

  console.log("\n1. Se adauga transportatorii");
  {
    await cer("/logistica/transportatori", { metoda: "post", body: { nume: "Palex", fel: "extern" } });
    await cer("/logistica/transportatori", { metoda: "post", body: { nume: "Dubita 3,5t", fel: "intern" } });
    const t = q("SELECT id, nume, fel FROM transportatori ORDER BY id");
    bine("amandoi sunt in baza", t.length === 2, JSON.stringify(t));
    bine("dubita e marcata ca interna", t[1].fel === "intern");

    const p = await cer("/logistica/transportatori");
    bine("pagina se deschide", p.cod === 200);
    bine(
      "si striga ca masina neconfigurata nu intra in comparatie",
      /neconfigurată — nu intră în comparație/.test(p.corp)
    );
    bine("Palex apare ca fiind fara oferta", /fără ofertă/.test(p.corp));
  }

  const palex = Number(q("SELECT id FROM transportatori WHERE nume = 'Palex'")[0].id);
  const dubita = Number(q("SELECT id FROM transportatori WHERE fel = 'intern'")[0].id);

  console.log("\n2. Oferta lui Palex, cu grila de tarife");
  {
    await cer("/logistica/oferta", {
      metoda: "post",
      body: {
        transportator_id: String(palex), nume: "Tarif 2026", valabil_de_la: "2026-01-01",
        valabil_pana_la: "2026-12-31", moneda: "RON", suprataxa_combustibil_pct: "0",
      },
    });
    const of = q("SELECT id FROM transport_oferte")[0];
    bine("oferta e in baza", !!of);
    await cer("/logistica/oferta/:id/tarif", {
      metoda: "post", params: { id: String(of.id) },
      body: { fel: "palet", pret: "300", zile_livrare: "2", capacitate_paleti: "10" },
    });
    const p = await cer("/logistica/oferta/:id", { params: { id: String(of.id) } });
    bine("grila se vede pe pagina ofertei, cu moneda scrisa o singura data", /300,00 lei \/palet/.test(p.corp), (p.corp.match(/[^>]{0,16}\/palet/) || [])[0]);
    bine("si durata", /2 zile/.test(p.corp));
  }

  console.log("\n3. Dubita se configureaza");
  {
    await cer("/logistica/transportator/:id", {
      metoda: "post", params: { id: String(dubita) },
      body: {
        nume: "Dubita 3,5t", consum_l_100km: "12", pret_carburant: "7.8", cost_km_uzura: "0.35",
        cost_ora_sofer: "40", diurna_zi: "150", taxe_cursa: "50", viteza_medie_kmh: "70",
        ore_incarcare: "2", ore_max_zi: "9", capacitate_kg: "1200", capacitate_paleti: "6", activ: "1",
      },
    });
    const t = q("SELECT consum_l_100km, capacitate_paleti FROM transportatori WHERE id = " + dubita)[0];
    bine("consumul s-a scris", Number(t.consum_l_100km) === 12, JSON.stringify(t));
    const p = await cer("/logistica/transportatori");
    bine("si nu mai scrie ca e neconfigurata", !/neconfigurată/.test(p.corp));
  }

  console.log("\n4. O cursa cu un palet la Timisoara");
  let cursa;
  {
    await cer("/logistica/cursa/noua", {
      metoda: "post",
      body: { client: "Client Vest SRL", localitate: "Timisoara", judet: "Timis", paleti: "1",
              greutate_kg: "400", data_livrare_ceruta: peste20 },
    });
    cursa = Number(q("SELECT id FROM transport_curse ORDER BY id DESC LIMIT 1")[0].id);
    const p = await cer("/logistica/cursa/:id", { params: { id: String(cursa) } });
    bine("pagina cursei se deschide", p.cod === 200);
    // Fara km, dubita nu poate fi calculata — si se cere distanta, nu se
    // pune zero.
    bine("cere kilometrii", /Nu știm câți kilometri/.test(p.corp));
    bine("Palex intra oricum, tariful lui e pe palet", /Palex/.test(p.corp));
  }

  console.log("\n5. Se scriu kilometrii, o data");
  {
    await cer("/logistica/cursa/:id/detalii", {
      metoda: "post", params: { id: String(cursa) },
      body: { paleti: "1", greutate_kg: "400", km: "550", localitate: "Timisoara",
              data_ridicare: azi, data_livrare_ceruta: peste20 },
    });
    const d = q("SELECT localitate, km FROM transport_distante");
    bine("distanta s-a tinut minte pentru data viitoare", d.length === 1 && Number(d[0].km) === 550, JSON.stringify(d));

    const p = await cer("/logistica/cursa/:id", { params: { id: String(cursa) } });
    bine("acum intra amandoi in clasament", /Palex/.test(p.corp) && /Dubita/.test(p.corp));
    bine("recomandarea e Palex", /recomandat[\s\S]{0,400}Palex/.test(p.corp));
    // Cazul lui Vali, verificat pe pagina, nu doar in biblioteca.
    bine(
      "pagina spune ca reteaua de paletizare bate masina proprie",
      /rețeaua de paletizare bate întotdeauna mașina proprie/.test(p.corp)
    );
    bine("si se vede pretul dubitei, peste 2000 lei", /2[.,]\d{3}[.,]\d{2}/.test(p.corp), p.corp.match(/\d[\d.,]{4,}/g));

    // Pagina de distante: coloana a doua e ce se socoteste de fapt.
    const dd = await cer("/logistica/distante");
    bine("pagina de distante arata si dus-intors", /1100 km/.test(dd.corp));
  }

  console.log("\n6. Alocarea pe mașina proprie o si rezerva");
  {
    await cer("/logistica/cursa/:id/aloca", {
      metoda: "post", params: { id: String(cursa) },
      body: { transportator_id: String(dubita), cost: "2472.6", moneda: "RON", zile: "2",
              recomandat: "0", motiv: "clientul vrea marfa in mana noastra" },
    });
    const c = q("SELECT transportator_id, stare, cost_estimat, motiv_alegere, clasament_json FROM transport_curse WHERE id = " + cursa)[0];
    bine("cursa e alocata", c.stare === "alocata" && Number(c.transportator_id) === dubita);
    bine("motivul s-a pastrat", /marfa in mana noastra/.test(c.motiv_alegere || ""));
    bine("clasamentul s-a inghetat pe cursa", (c.clasament_json || "").length > 50);

    const r = q("SELECT * FROM transport_rezervari WHERE cursa_id = " + cursa + " AND stare = 'activa'");
    bine("masina s-a rezervat automat", r.length === 1, JSON.stringify(r));
    bine("rezervarea spune pentru ce e", /cursa #/.test(r[0].ce || ""), r[0] && r[0].ce);

    // A doua cursa in aceleasi zile nu mai are voie sa vada dubita libera.
    await cer("/logistica/cursa/noua", {
      metoda: "post",
      body: { client: "Alt client", localitate: "Timisoara", judet: "Timis", paleti: "1", greutate_kg: "300",
              data_livrare_ceruta: peste20 },
    });
    const c2 = Number(q("SELECT id FROM transport_curse ORDER BY id DESC LIMIT 1")[0].id);
    await cer("/logistica/cursa/:id/detalii", {
      metoda: "post", params: { id: String(c2) },
      body: { paleti: "1", greutate_kg: "300", km: "550", localitate: "Timisoara", data_ridicare: azi },
    });
    const p2 = await cer("/logistica/cursa/:id", { params: { id: String(c2) } });
    bine("a doua cursa n-o mai vede libera", /rezervată/.test(p2.corp), "nu apare in excluse");
    bine("si scrie pentru ce e luata", /cursa #/.test(p2.corp));
  }

  console.log("\n7. Dezalocarea rupe rezervarea");
  {
    await cer("/logistica/cursa/:id/dezaloca", { metoda: "post", params: { id: String(cursa) } });
    const c = q("SELECT stare, transportator_id, cost_estimat FROM transport_curse WHERE id = " + cursa)[0];
    bine("cursa se intoarce la „de alocat”", c.stare === "de_alocat" && !c.transportator_id);
    bine("costul se sterge, nu ramane de la alocarea veche", !c.cost_estimat);
    const r = q("SELECT stare FROM transport_rezervari WHERE cursa_id = " + cursa);
    bine("rezervarea e anulata", r.every((x) => x.stare === "anulata"), JSON.stringify(r));
  }

  console.log("\n8. Alocare fara motiv cand nu e recomandarea");
  {
    const r = await cer("/logistica/cursa/:id/aloca", {
      metoda: "post", params: { id: String(cursa) },
      body: { transportator_id: String(dubita), cost: "2472.6", moneda: "RON", zile: "2", recomandat: "0" },
    });
    const c = q("SELECT stare FROM transport_curse WHERE id = " + cursa)[0];
    bine("nu se aloca", c.stare === "de_alocat");
    bine(
      "si se spune de ce",
      /eroare=.*nimeni/.test(decodeURIComponent((r.antet && r.antet.Location) || "")),
      r.antet && r.antet.Location
    );
  }

  console.log("\n9. Coada: comenzile gata de livrat, fara cursa");
  {
    q("INSERT INTO parteneri (tip, nume, adresa) VALUES ('client', 'Gata SRL', 'Str. Test 1, Brasov')");
    const pid = q("SELECT id FROM parteneri WHERE nume = 'Gata SRL'")[0].id;
    q(`INSERT INTO comenzi (partener_id, numar, status, data_livrare_promisa) VALUES (${pid}, 'CMD-991', 'in_stoc_depozit', '${peste3}')`);
    const p = await cer("/logistica", { query: {} });
    bine("comanda apare in coada", /CMD-991/.test(p.corp));
    bine("cu butonul de deschis cursa", /Deschide cursă/.test(p.corp));

    const cid = Number(q("SELECT id FROM comenzi WHERE numar = 'CMD-991'")[0].id);
    await cer("/logistica/cursa/din-comanda/:id", { metoda: "post", params: { id: String(cid) } });
    const noua = q(`SELECT client, adresa, data_livrare_ceruta FROM transport_curse WHERE comanda_id = ${cid}`)[0];
    bine("cursa se naste cu clientul si adresa din comanda", noua && /Gata SRL/.test(noua.client) && /Brasov/.test(noua.adresa || ""), JSON.stringify(noua));
    bine("si cu termenul promis clientului", noua && noua.data_livrare_ceruta === peste3, noua && noua.data_livrare_ceruta);

    const p2 = await cer("/logistica", { query: {} });
    bine("si nu mai apare a doua oara in coada", !/CMD-991[\s\S]{0,200}Deschide cursă/.test(p2.corp));
  }

  console.log("\n10. Oferta expirata, pe pagina");
  {
    q(`UPDATE transport_oferte SET valabil_pana_la = '2025-12-31'`);
    const p = await cer("/logistica/cursa/:id", { params: { id: String(cursa) } });
    bine("Palex iese din clasament", !/recomandat[\s\S]{0,300}Palex/.test(p.corp));
    // layout() trece tot corpul prin dateleInText(), deci data iese scrisa
    // romaneste. Biblioteca produce ISO, pagina il arata ca 31.12.2025.
    const linie = (p.corp.match(/[^<>]*cere tarif nou[^<>]*/) || ["(nimic)"])[0];
    bine("si se spune ca oferta a expirat, cu data scrisa omeneste", /a expirat pe 31\.12\.2025/.test(p.corp), linie);
    bine("cu ce are de facut omul", /cere tarif nou/.test(p.corp));
    q(`UPDATE transport_oferte SET valabil_pana_la = '2026-12-31'`);
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
