"use strict";
// Recepția marfii, pe pagini si pe PostgreSQL real (prin psql).
//
// Regulile au testele lor in test-receptie.js. Aici se verifica drumul
// intreg: productia termina → trimite in depozit → depozitul face receptia
// rand cu rand → stocul se scrie o SINGURA data.
//
// CE APARA:
//
//   • STOCUL NU SE SCRIE DE DOUA ORI. Cel mai scump bug posibil in modulul
//     asta, si cel mai usor de produs: un refresh pe POST.
//
//   • MARFA STRICATA NU AJUNGE PE STOCUL VANDABIL. Un retur deteriorat
//     trebuie sa se vada pe document, dar sa nu se poata vinde.
//
//   • PRODUCTIA NU TRIMITE DE DOUA ORI ACEEASI COMANDA. Ar iesi doua
//     receptii pe aceeasi marfa si nimeni n-ar sti care e buna.
//
//   • APROVIZIONAREA SE INCHIDE ODATA CU RECEPTIA. Altfel ramane in lista
//     „de aprovizionat” cu marfa deja in depozit, si o comanda cineva iar.
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

const rute = { get: {}, post: {} };
const reg = { get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } };
require(path.join(RAD, "modules", "receptie.js")).register(reg);
require(path.join(RAD, "modules", "productie.js")).register(reg);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get", rol = "depozit" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol }, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const unde = (r) => decodeURIComponent((r.antet && r.antet.Location) || "");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 240) : "")); esecuri++; }
}

function curata() {
  q("DELETE FROM miscari_stoc WHERE document_ref LIKE 'REC-%'");
  q("DELETE FROM receptii_linii");
  q("DELETE FROM receptii");
  q("DELETE FROM locuri_depozit WHERE cod LIKE 'T-%'");
  q("DELETE FROM comenzi_productie_linii WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE numar LIKE 'RP-%')");
  q("DELETE FROM comenzi_productie WHERE numar LIKE 'RP-%'");
}

(async () => {
  curata();
  const produs = Number(unul("SELECT id FROM produse ORDER BY id LIMIT 1"));
  const produs2 = Number(unul("SELECT id FROM produse ORDER BY id OFFSET 1 LIMIT 1"));
  let depozit = unul("SELECT id FROM depozite ORDER BY id LIMIT 1");
  if (!depozit) { q("INSERT INTO depozite (denumire) VALUES ('Depozit test')"); depozit = unul("SELECT id FROM depozite ORDER BY id LIMIT 1"); }

  console.log("\n1. Locurile din depozit, generate în serie");
  {
    await cer("/depozit/locuri/serie", { metoda: "post", body: { prefix: "T", rafturi: "3", niveluri: "2", zona: "Hala test" } });
    bine("s-au făcut 6 locuri", Number(unul("SELECT count(*) FROM locuri_depozit WHERE cod LIKE 'T-%'")) === 6);
    bine("cu coduri citibile", !!unul("SELECT id FROM locuri_depozit WHERE cod = 'T-02-1'"));
    // Rulat de doua ori nu face dubluri: omul va apasa din nou, garantat.
    await cer("/depozit/locuri/serie", { metoda: "post", body: { prefix: "T", rafturi: "3", niveluri: "2", zona: "Hala test" } });
    bine("rulat a doua oară nu face dubluri", Number(unul("SELECT count(*) FROM locuri_depozit WHERE cod LIKE 'T-%'")) === 6);
  }
  const loc = Number(unul("SELECT id FROM locuri_depozit WHERE cod = 'T-01-1'"));

  console.log("\n2. Producția termină și trimite marfa în depozit");
  let receptieProd;
  {
    q(`INSERT INTO comenzi_productie (numar, tip_produs, cantitate, um, status, produs_id, data_initiere)
       VALUES ('RP-001', 'Folie test', '500', 'kg', 'finalizata', ${produs}, '2026-10-23')`);
    const cp = Number(unul("SELECT id FROM comenzi_productie WHERE numar='RP-001'"));
    const r = await cer("/productie/:id/trimite-depozit", { metoda: "post", params: { id: String(cp) }, rol: "productie" });
    bine("duce direct la recepție", /\/depozit\/receptie\/\d+/.test(unde(r)), unde(r));
    receptieProd = Number(unul("SELECT id FROM receptii WHERE comanda_productie_id = " + cp));
    bine("recepția s-a născut", !!receptieProd);
    const rec = q("SELECT * FROM receptii WHERE id = " + receptieProd)[0];
    bine("marcată ca venită din producție", rec.sursa === "productie");
    bine("și anunțată, nu făcută", rec.stare === "asteptata");
    const li = q("SELECT * FROM receptii_linii WHERE receptie_id = " + receptieProd);
    bine("cu un rând, cu cantitatea anunțată", li.length === 1 && Number(li[0].cantitate_asteptata) === 500);
    bine("dar FĂRĂ cantitate primită — n-a văzut-o nimeni încă", li[0].cantitate_primita === null);
    // Marfa nu e pe stoc pana n-o vede depozitul. Asta e tot rostul.
    bine("și fără nicio mișcare de stoc", Number(unul("SELECT count(*) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'")) === 0);

    // A doua apasare n-are voie sa deschida a doua receptie.
    await cer("/productie/:id/trimite-depozit", { metoda: "post", params: { id: String(cp) }, rol: "productie" });
    bine("trimis a doua oară nu face a doua recepție", Number(unul("SELECT count(*) FROM receptii WHERE comanda_productie_id = " + cp)) === 1);
  }

  console.log("\n3. Recepția, rând cu rând");
  {
    const li = Number(unul("SELECT id FROM receptii_linii WHERE receptie_id = " + receptieProd));
    // Lipsa fara explicatie nu trece.
    const fara = await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(receptieProd), lid: String(li) },
      body: { cantitate_primita: "450", loc_id: String(loc) },
    });
    bine("lipsa fără explicație e oprită", unul(`SELECT cantitate_primita FROM receptii_linii WHERE id=${li}`) === null);
    bine("și la producție scrie că e pierdere, nu reclamație", /pierderea nu se vede/.test(unde(fara)), unde(fara));

    const cu = await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(receptieProd), lid: String(li) },
      body: { cantitate_primita: "450", loc_id: String(loc), motiv: "rebut la pornire", lot: "L-2026-10" },
    });
    const d = q("SELECT * FROM receptii_linii WHERE id = " + li)[0];
    bine("cu explicație trece", Number(d.cantitate_primita) === 450, d.cantitate_primita);
    bine("locul se scrie", Number(d.loc_id) === loc);
    bine("lotul la fel", d.lot === "L-2026-10");
    bine("rândul e primit", d.stare === "primita");
    bine("și pagina spune cât lipsește", /lipsesc 50/.test(unde(cu)), unde(cu));
    // Prima linie atinsa muta receptia in lucru, ca sa se vada pe lista.
    bine("recepția trece în lucru", unul("SELECT stare FROM receptii WHERE id = " + receptieProd) === "in_lucru");
    bine("și se știe cine o face", unul("SELECT primita_de FROM receptii WHERE id = " + receptieProd) === "Vali");
  }

  console.log("\n4. Finalizarea scrie stocul — o singură dată");
  {
    const inainte = Number(unul("SELECT COALESCE(SUM(cantitate),0) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'"));
    const r = await cer("/depozit/receptie/:id/finalizeaza", { metoda: "post", params: { id: String(receptieProd) } });
    const dupa = Number(unul("SELECT COALESCE(SUM(cantitate),0) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'"));
    bine("stocul creşte cu 450, nu cu 500", dupa - inainte === 450, dupa - inainte);
    bine("recepția e finalizată", unul("SELECT stare FROM receptii WHERE id = " + receptieProd) === "finalizata");
    bine("mesajul spune ce s-a întâmplat", /a intrat pe stoc/.test(unde(r)), unde(r));
    bine("inclusiv lipsa", /cu lipsă/.test(unde(r)), unde(r));
    bine("mișcarea ține minte locul", /loc T-01-1/.test(String(unul("SELECT observatii FROM miscari_stoc WHERE document_ref LIKE 'REC-%' ORDER BY id DESC LIMIT 1"))));

    // ASTA E LINIA CARE APARA STOCUL.
    const r2 = await cer("/depozit/receptie/:id/finalizeaza", { metoda: "post", params: { id: String(receptieProd) } });
    const dupa2 = Number(unul("SELECT COALESCE(SUM(cantitate),0) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'"));
    bine("a doua finalizare NU mai scrie nimic", dupa2 === dupa, dupa2 + " vs " + dupa);
    bine("și spune exact ce s-ar fi întâmplat", /l-ar dubla/.test(unde(r2)), unde(r2));

    // Nici randurile nu se mai schimba dupa inchidere.
    const li = Number(unul("SELECT id FROM receptii_linii WHERE receptie_id = " + receptieProd));
    const r3 = await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(receptieProd), lid: String(li) }, body: { cantitate_primita: "9999", loc_id: String(loc) },
    });
    bine("rândurile sunt înghețate după finalizare", Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id=${li}`)) === 450);
    bine("și se spune de ce", /închisă/.test(unde(r3)), unde(r3));

    // O receptie finalizata nu se mai poate anula: stocul e deja scris.
    const r4 = await cer("/depozit/receptie/:id/anuleaza", { metoda: "post", params: { id: String(receptieProd) } });
    bine("nici anulată nu mai poate fi", unul("SELECT stare FROM receptii WHERE id = " + receptieProd) === "finalizata");
    bine("fiindcă marfa ar rămâne pe stoc fără document", /fără document/.test(unde(r4)), unde(r4));
  }

  console.log("\n5. Retur: marfa stricată nu ajunge pe stocul vandabil");
  {
    await cer("/depozit/receptie/noua", {
      metoda: "post",
      body: { sursa: "retur_tert", data: "2026-10-23", document_extern: "AWB 123", depozit_id: String(depozit) },
    });
    const rec = Number(unul("SELECT id FROM receptii WHERE sursa='retur_tert' ORDER BY id DESC LIMIT 1"));
    await cer("/depozit/receptie/:id/linie", {
      metoda: "post", params: { id: String(rec) }, body: { produs_id: String(produs), cantitate: "10", um: "buc" },
    });
    await cer("/depozit/receptie/:id/linie", {
      metoda: "post", params: { id: String(rec) }, body: { produs_id: String(produs2), cantitate: "4", um: "buc" },
    });
    const li = q("SELECT id FROM receptii_linii WHERE receptie_id = " + rec + " ORDER BY id");

    // Fara starea marfii, returul nu trece.
    const fara = await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(rec), lid: String(li[0].id) }, body: { cantitate_primita: "10", loc_id: String(loc) },
    });
    bine("retur fără starea mărfii: oprit", unul(`SELECT cantitate_primita FROM receptii_linii WHERE id=${li[0].id}`) === null);
    bine("cu motivul scris pe șleau", /se vinde a doua oară/.test(unde(fara)), unde(fara));

    await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(rec), lid: String(li[0].id) },
      body: { cantitate_primita: "10", loc_id: String(loc), conditie: "bun" },
    });
    await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(rec), lid: String(li[1].id) },
      body: { cantitate_primita: "4", conditie: "deteriorat" },
    });

    const inainte = Number(unul("SELECT COALESCE(SUM(cantitate),0) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'"));
    const r = await cer("/depozit/receptie/:id/finalizeaza", { metoda: "post", params: { id: String(rec) } });
    const dupa = Number(unul("SELECT COALESCE(SUM(cantitate),0) FROM miscari_stoc WHERE document_ref LIKE 'REC-%'"));
    bine("pe stoc intră doar cele 10 bune, nu și cele 4 stricate", dupa - inainte === 10, dupa - inainte);
    bine("dar cele stricate se văd pe document", Number(unul(`SELECT count(*) FROM receptii_linii WHERE receptie_id=${rec} AND conditie='deteriorat'`)) === 1);
    bine("și mesajul le numește", /marfă stricată NU/.test(unde(r)), unde(r));
  }

  console.log("\n6. Aprovizionarea se închide odată cu recepția");
  {
    q(`INSERT INTO aprovizionari (produs_id, cantitate, sursa, status, cerut_de, creata_la, termen_cerut)
       VALUES (${produs}, 20, 'tert', 'confirmata', 'TEST-REC', '2026-10-23', '2026-11-01')`);
    const ap = Number(unul("SELECT id FROM aprovizionari WHERE cerut_de='TEST-REC' ORDER BY id DESC LIMIT 1"));
    const rid = await require(path.join(RAD, "modules", "receptie.js")).creeaza(
      { sursa: "furnizor", aprovizionare_id: ap, depozit_id: depozit, anuntata_de: "Vali" },
      [{ produs_id: produs, cantitate: 20, um: "buc" }]
    );
    const li = Number(unul("SELECT id FROM receptii_linii WHERE receptie_id = " + rid));
    await cer("/depozit/receptie/:id/linie/:lid", {
      metoda: "post", params: { id: String(rid), lid: String(li) }, body: { cantitate_primita: "20", loc_id: String(loc) },
    });
    await cer("/depozit/receptie/:id/finalizeaza", { metoda: "post", params: { id: String(rid) } });
    bine("aprovizionarea trece în „primită”", unul("SELECT status FROM aprovizionari WHERE id = " + ap) === "primita");
    q("DELETE FROM aprovizionari WHERE cerut_de='TEST-REC'");
  }

  console.log("\n7. Paginile se deschid");
  {
    const lista = await cer("/depozit/receptie", { query: {} });
    bine("lista răspunde", lista.cod === 200);
    // Implicit se arata doar ce e DE FACUT. Cele finalizate ar ingropa
    // coada de lucru sub istoric dupa doua saptamani.
    bine("implicit nu arată și cele finalizate", !/REC-/.test(lista.corp), (lista.corp.match(/REC-[^<]*/) || [])[0]);
    const toate = await cer("/depozit/receptie", { query: { stare: "toate" } });
    bine("dar pe „toate” se văd", /REC-/.test(toate.corp));
    const fisa = await cer("/depozit/receptie/:id", { params: { id: String(receptieProd) } });
    bine("fișa răspunde", fisa.cod === 200);
    bine("recepția închisă n-are casete de scris", !/name="cantitate_primita"/.test(fisa.corp));
    bine("dar arată ce s-a primit", /450/.test(fisa.corp));
    const locuri = await cer("/depozit/locuri");
    bine("pagina de locuri răspunde", locuri.cod === 200 && /T-01-1/.test(locuri.corp));
  }

  // SECTIUNEA 8 verifica harta de depozit pe care am construit-o si pe care
  // Vali a cerut s-o scot: harta care conteaza e cea din CT-Park, care
  // exista deja si are structura reala a halei. Testele pentru alegerea
  // locurilor cu degetul si pentru paletul lat stau acum in
  // test-ct-park-harta.js, pe harta aia.
  //
  // Ce a ramas aici, si se verifica mai sus: generarea locurilor, receptia
  // rand cu rand, si scrierea stocului pe loc.

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
