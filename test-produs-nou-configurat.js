"use strict";
// Produsul nou se face doar din configurator, cu tot cu fișa lui. Pe rutele
// adevărate, cu o bază de date falsă; nu atinge Postgres (scrierea în
// Postgres-ul adevărat o verifică test-produse-nomenclator.js și
// test-cod-produs-pastrat.js).
//
// Cererea lui Vali, 04.11.2026:
//   „Când adăugăm produs nou, codul produsului trebuie să se autogenereze
//    conform algoritmului din configurări, nu să-l introducem noi, iar
//    câmpurile trebuie să fie și cele din configurare."
//
// CE APĂRĂ:
//
//   • NICIUN CÂMP AL FIȘEI NU RĂMÂNE ÎN URMĂ. Fiecare câmp scris al fișei de
//     produs (Editare, modules/produse.js), în afară de cod, e și în
//     formularul de produs nou, cu aceeași valoare implicită. Un câmp adăugat
//     doar la fișă ar fi rămas gol la fiecare produs nou.
//
//   • CODUL NU SE SCRIE. Formularul n-are căsuță de cod, iar un `cod` trimis
//     oricum nu se citește.
//
//   • CE SCRIE OMUL AJUNGE ÎN BAZĂ, PE COLOANA EI: categorie, gestiune,
//     prețuri, adaos, TVA, stoc minim, cine l-a făcut. Golul rămâne NULL unde
//     „nu știu" e un răspuns (cost de producție, adaos, preț minim).
//
//   • UN REFUZ NU ȘTERGE CE S-A SCRIS. Un număr care nu se poate citi, o
//     caracteristică lipsă sau un produs care există deja întorc formularul
//     cu tot ce era în el și cu motivul deasupra, nu o pagină cu „Înapoi".
//
//   • DOUĂ SALVĂRI ÎN ACEEAȘI SECUNDĂ nu dau o eroare de server: a doua află
//     care e produsul.
//
//   • COMANDA SCRIE CA ÎNAINTE. Produsul făcut de pe comandă (doar cu UM)
//     intră cu prețuri zero, TVA 21% și costurile necunoscute.
//
//   • FORMULARUL GENERIC: cu `adaugare`, „/nou" și POST-ul trimit la pagina
//     modulului și nu scriu nimic; fără, rămân cum erau.
const Module = require("module");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 300) : ""));
    esecuri++;
  }
}

const { START } = require("./lib/cod-familii");
const FAM = { "Plic AWB": 4, "Hârtie": 9 };

const BAZA = { familii: [], caracteristici: [], valori: [], produse: [], inserturi: [], dubluLaInsert: false };
{
  let cid = 0;
  let vid = 0;
  for (const [nume, exemplu, lista] of START) {
    if (!FAM[nume]) continue;
    BAZA.familii.push({ id: FAM[nume], nume, exemplu, activ: 1, ordine: FAM[nume] });
    for (const c of lista) {
      const [cn, fel, um, ordine, cifre, valori, minv, maxv, inCod, oblig] = c;
      const id = ++cid;
      BAZA.caracteristici.push({
        id, familie_id: FAM[nume], nume: cn, fel, um: um || null, activ: 1,
        in_cod: inCod === 0 ? 0 : 1, ordine, obligatoriu: oblig === 0 ? 0 : 1,
        cifre: cifre || 0, min_val: minv == null ? null : minv, max_val: maxv == null ? null : maxv,
      });
      for (const [valoare, cod, umV] of valori || []) {
        BAZA.valori.push({ id: ++vid, caracteristica_id: id, valoare, cod, ordine: vid, activ: 1, um: umV || null });
      }
    }
  }
}
// Un plic care există deja, ca să se vadă refuzul.
BAZA.produse.push({ id: 70, cod: "PA17524025", cod_generat: "PA17524025", denumire: "Plic AWB 175×240", categorie: "Plicuri" });
BAZA.produse.push({ id: 71, cod: "X1", cod_generat: null, denumire: "Altceva", categorie: "Ambalaje", gestiune: "Marfă" });

let urmatorulId = 100;
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      if (/FROM produse x WHERE x\.cod_generat/i.test(s)) {
        const cod = String(a[0] || "");
        return BAZA.produse.find((p) => p.cod_generat === cod || String(p.cod || "").trim().toUpperCase() === cod);
      }
      if (/FROM setari_app/i.test(s)) return null;
      if (/COUNT\(\*\) AS n FROM produse WHERE cota_tva = 19/i.test(s)) return { n: 0 };
      if (/SELECT COUNT\(\*\) AS n FROM/i.test(s)) return { n: 0 };
      return undefined;
    },
    async all(...a) {
      if (/FROM cod_familii/i.test(s)) return BAZA.familii;
      if (/FROM cod_caracteristici/i.test(s)) {
        const m = s.match(/familie_id = (\d+)/);
        const f = m ? Number(m[1]) : null;
        return BAZA.caracteristici.filter((c) => (f ? c.familie_id === f : c.familie_id == null) && c.activ);
      }
      if (/FROM cod_valori/i.test(s)) return BAZA.valori;
      const d = s.match(/SELECT DISTINCT (\w+) AS v FROM (\w+)/i);
      if (d) {
        const rand = d[2] === "produse" ? BAZA.produse : [];
        return [...new Set(rand.map((p) => p[d[1]]).filter((x) => x != null && x !== ""))].sort().map((v) => ({ v }));
      }
      return [];
    },
    async run(...a) {
      if (/^INSERT/i.test(s)) BAZA.inserturi.push({ sql: s, a });
      if (/INSERT INTO produse \(/i.test(s)) {
        if (BAZA.dubluLaInsert) {
          BAZA.dubluLaInsert = false;
          // Între previzualizare și salvare, altă fereastră a scris același
          // produs: indexul unic pe cod_generat refuză.
          BAZA.produse.push({ id: 90, cod: a[0], cod_generat: a[1], denumire: "Scris din altă fereastră" });
          const e = new Error('duplicate key value violates unique constraint "idx_produse_cod_generat"');
          e.code = "23505";
          throw e;
        }
        const id = ++urmatorulId;
        BAZA.produse.push({ id, cod: a[0], cod_generat: a[1], denumire: a[2], unitate_masura: a[3] });
        return { lastInsertRowid: id };
      }
      return { lastInsertRowid: ++urmatorulId, changes: 1 };
    },
  };
}
const dbFals = { prepare: fals, exec: async () => {}, migrate: async () => {} };
function injecteaza(cale, obiect) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = obiect;
  require.cache[abs] = m;
}
injecteaza("./lib/db", dbFals);

// Opțiunile date de modules/produse.js formularului generic: de acolo se
// citesc câmpurile fișei.
const crud = require("./lib/crud");
const registerCrudAdevarat = crud.registerCrud;
let optiuniProduse = null;
crud.registerCrud = (router, opts) => {
  if (opts.path === "/produse") optiuniProduse = opts;
  return registerCrudAdevarat(router, opts);
};

const codProdus = require("./modules/cod-produs");
const produse = require("./modules/produse");

function routerNou() {
  const rute = [];
  return {
    rute,
    get: (cale, h) => rute.push(["GET", cale, h]),
    post: (cale, h) => rute.push(["POST", cale, h]),
    use: () => {},
  };
}
const R = routerNou();
// Ordinea din server.js; prima rută înregistrată câștigă.
codProdus.register(R);
produse.register(R);

async function cheama(router, metoda, cale, corp, user, query) {
  const r = router.rute.find((x) => x[0] === metoda && x[1] === cale);
  if (!r) throw new Error("ruta lipsește: " + metoda + " " + cale);
  let stare = 0;
  let text = "";
  let antet = {};
  const res = {
    writeHead(st, h) { stare = st; antet = h || {}; },
    end(t) { text = t == null ? "" : String(t); },
    setHeader() {},
  };
  await r[2]({ req: { url: cale }, res, params: {}, query: query || {}, body: corp, user });
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { stare, text, json, antet };
}

const ADMIN = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 5, nume: "Agent", rol: "agent" };
const idCar = (fam, nume) => BAZA.caracteristici.find((c) => c.familie_id === FAM[fam] && c.nume === nume).id;
function corp(fam, alegeri, extra) {
  const o = { familie: String(FAM[fam]), ...(extra || {}) };
  for (const [k, v] of Object.entries(alegeri)) o["c_" + idCar(fam, k)] = String(v);
  return o;
}
const PLIC = { Tip: "Plic AWB", "Lățime": 200, Lungime: 300, "Grosime CPE": 50, "Buzunar documente": "Da" };
const FISA = {
  denumire: "", categorie: " Plicuri ", gestiune: "Marfă", unitate_masura: "buc",
  pret_achizitie: "0,12", pret_productie: "", adaos_lista: "35", pret_minim: "0,15",
  pret_vanzare: "0,2", cota_tva: "21", stoc_minim: "500",
};
const produseScrise = () => BAZA.inserturi.filter((x) => /INSERT INTO produse \(/i.test(x.sql));
// Parametrii INSERT-ului, pe numele coloanelor lui.
function peColoane(ins) {
  const m = ins.sql.match(/INSERT INTO produse \(([^)]+)\)/i);
  const col = m[1].split(",").map((x) => x.trim());
  return Object.fromEntries(col.map((c, i) => [c, ins.a[i]]));
}

(async () => {
  console.log("Formularul");
  const f = await cheama(R, "GET", "/produse/nou-cu-cod", null, ADMIN, { familie: String(FAM["Plic AWB"]) });
  {
    bine("se deschide", f.stare === 200, f.stare);
    bine("are caracteristicile familiei alese", PLIC && Object.keys(PLIC).every((k) => f.text.includes(`name="c_${idCar("Plic AWB", k)}"`)));
    bine("n-are căsuță pentru cod", !/name="cod"/.test(f.text));
    bine("arată familiile ca să poți alege alta", /href="\/produse\/nou-cu-cod\?familie=9"/.test(f.text));
    bine("trimite spre Configurări pentru un fel de produs nou", /familie nouă/.test(f.text) && /href="\/configurari\/cod-produs\?familie=4"/.test(f.text));
    bine("sugestiile de categorie vin din nomenclator",
      /<datalist id="dl_categorie"><option value="Ambalaje"><option value="Plicuri"><\/datalist>/.test(f.text));
    bine("sugestiile de gestiune la fel", /<datalist id="dl_gestiune"><option value="Marfă"><\/datalist>/.test(f.text));
    bine("numerele se scriu în căsuțe de text, cu virgulă", /name="pret_vanzare" value="0"/.test(f.text) && /inputmode="decimal" name="pret_vanzare"/.test(f.text));
  }
  {
    bine("modules/produse.js dă câmpurile fișei", optiuniProduse && Array.isArray(optiuniProduse.fields));
    const scrise = (optiuniProduse ? optiuniProduse.fields : []).filter((x) => x.type !== "calculat" && x.name !== "cod");
    const lipsa = scrise.filter((x) => !f.text.includes(`name="${x.name}"`)).map((x) => x.name);
    bine(`toate cele ${scrise.length} câmpuri scrise ale fișei, în afară de cod, sunt și aici`, scrise.length >= 10 && !lipsa.length, lipsa);
    const altaImplicita = scrise
      .filter((x) => x.default !== undefined && !new RegExp(`name="${x.name}" value="${String(x.default)}"`).test(f.text))
      .map((x) => x.name + "=" + x.default);
    bine("cu aceleași valori implicite (UM buc, TVA 21, prețuri 0)", !altaImplicita.length, altaImplicita);
    bine("butonul „Produs nou” din listă duce aici", optiuniProduse && optiuniProduse.adaugare === "/produse/nou-cu-cod");
  }

  console.log("\nSalvarea");
  {
    BAZA.inserturi = [];
    const r = await cheama(R, "POST", "/produse/nou-cu-cod", corp("Plic AWB", PLIC, { ...FISA, cod: "SCRIS-DE-MANA" }), ADMIN);
    const ins = produseScrise();
    const c = ins.length ? peColoane(ins[0]) : {};
    bine("se scrie un produs și duce la fișa lui", r.stare === 302 && ins.length === 1 && r.antet.Location === "/produse/" + BAZA.produse[BAZA.produse.length - 1].id, { r: r.stare, n: ins.length });
    bine("cu codul generat, nu cu cel trimis de mână", c.cod === "PA20030050" && c.cod_generat === "PA20030050", c);
    bine("denumirea goală se ia din caracteristici", c.denumire === "Plic AWB 200 mm 300 mm 50 microni Da", c.denumire);
    bine("categoria fără spațiile de la capete, gestiunea", c.categorie === "Plicuri" && c.gestiune === "Marfă", c);
    bine("prețurile scrise cu virgulă", c.pret_achizitie === 0.12 && c.pret_minim === 0.15 && c.pret_vanzare === 0.2, c);
    bine("costul de producție gol rămâne NULL, nu zero", c.pret_productie === null, c.pret_productie);
    bine("adaosul, TVA-ul, stocul minim", c.adaos_lista === 35 && c.cota_tva === 21 && c.stoc_minim === 500, c);
    bine("familia și cine l-a făcut", c.cod_familie_id === FAM["Plic AWB"] && c.creat_de === ADMIN.id && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(c.creat_la), c);
    const carScrise = BAZA.inserturi.filter((x) => /INSERT INTO produse_cod_valori/i.test(x.sql));
    bine("toate cele cinci caracteristici stau pe produs", carScrise.length === 5, carScrise.length);
  }
  {
    BAZA.inserturi = [];
    await cheama(R, "POST", "/produse/nou-cu-cod",
      corp("Plic AWB", { ...PLIC, "Lățime": 210 }, { ...FISA, denumire: "  Plic curier A4 cu buzunar  ", adaos_lista: "", pret_minim: "" }), AGENT);
    const c = peColoane(produseScrise()[0]);
    bine("denumirea scrisă de om câștigă, fără spațiile de la capete", c.denumire === "Plic curier A4 cu buzunar", c.denumire);
    bine("adaosul și prețul minim goale rămân NULL", c.adaos_lista === null && c.pret_minim === null, c);
  }
  {
    BAZA.inserturi = [];
    const r = await cheama(R, "POST", "/produse/nou-cu-cod",
      corp("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80, Ambalare: "Top" }, { ...FISA, unitate_masura: "cutie", pret_vanzare: "" }), ADMIN);
    const c = peColoane(produseScrise()[0]);
    bine("la hârtie UM-ul vine din ambalare, nu din căsuță", r.stare === 302 && c.unitate_masura === "top", c.unitate_masura);
    bine("prețul de vânzare gol intră zero, ca până acum", c.pret_vanzare === 0, c.pret_vanzare);
  }

  console.log("\nRefuzurile întorc formularul plin");
  {
    BAZA.inserturi = [];
    const r = await cheama(R, "POST", "/produse/nou-cu-cod",
      corp("Plic AWB", { ...PLIC, "Lățime": 220 }, { ...FISA, pret_vanzare: "1.234,50", categorie: "Plicuri noi" }), ADMIN);
    bine("un preț care nu se poate citi oprește salvarea", r.stare === 400 && !produseScrise().length, r.stare);
    bine("cu numele câmpului", /Preț vânzare \(fără TVA\): „1\.234,50(&quot;|") nu e un număr pozitiv/.test(r.text), (r.text.match(/flash-rosu">[^<]*/) || [""])[0]);
    bine("și cu ce scrisese omul, caracteristici și fișă",
      /value="Plicuri noi"/.test(r.text) && /value="1\.234,50"/.test(r.text) && new RegExp(`name="c_${idCar("Plic AWB", "Lățime")}" data-carac="\\d+" value="220"`).test(r.text));
    bine("valoarea aleasă din listă rămâne aleasă", /<option value="Da" selected>Da<\/option>/.test(r.text));
  }
  {
    BAZA.inserturi = [];
    const { Lungime, ...faraLungime } = PLIC;
    const r = await cheama(R, "POST", "/produse/nou-cu-cod", corp("Plic AWB", faraLungime, { ...FISA, gestiune: "Producție" }), ADMIN);
    bine("o caracteristică lipsă oprește salvarea, cu numele ei", r.stare === 400 && /Mai lipsește: Lungime/.test(r.text) && !produseScrise().length, r.stare);
    bine("iar gestiunea scrisă rămâne în formular", /name="gestiune" value="Producție"/.test(r.text));
  }
  {
    BAZA.inserturi = [];
    const r = await cheama(R, "POST", "/produse/nou-cu-cod",
      corp("Plic AWB", { Tip: "Plic AWB", "Lățime": 175, Lungime: 240, "Grosime CPE": 25, "Buzunar documente": "Nu" }, { ...FISA, denumire: "Plic scris de mine" }), ADMIN);
    bine("un produs care există deja nu se face a doua oară", r.stare === 400 && !produseScrise().length, r.stare);
    bine("mesajul duce la el", /Produsul există deja: <a href="\/produse\/70">Plic AWB 175×240<\/a>/.test(r.text));
    bine("denumirea scrisă de om nu mai e înlocuită de cea din caracteristici", /name="denumire" value="Plic scris de mine" data-auto="0"/.test(r.text));
  }
  {
    BAZA.inserturi = [];
    BAZA.dubluLaInsert = true;
    const r = await cheama(R, "POST", "/produse/nou-cu-cod", corp("Plic AWB", { ...PLIC, "Lățime": 230 }, FISA), ADMIN);
    bine("două salvări în aceeași secundă: a doua primește formularul, nu o eroare de server",
      r.stare === 400 && /Produsul există deja: <a href="\/produse\/90">Scris din altă fereastră<\/a>/.test(r.text), r.stare);
  }
  {
    const r = await cheama(R, "GET", "/produse/nou-cu-cod", null, ADMIN, { vechi: "1" });
    bine("venit din formularul vechi, află de ce nu s-a salvat", /Formularul vechi de produs nou nu mai scrie produse/.test(r.text));
    const r2 = await cheama(R, "GET", "/produse/nou-cu-cod", null, ADMIN, { familie: "999" });
    bine("o familie care nu există cade pe prima, nu pe un formular gol", /name="familie" id="f-familie" value="4"/.test(r2.text));
  }

  console.log("\nComanda scrie ca înainte");
  {
    BAZA.inserturi = [];
    const { r, id, creat } = await codProdus.produsulAlegerilor(
      Object.fromEntries(Object.entries({ ...PLIC, "Lățime": 240 }).map(([k, v]) => [idCar("Plic AWB", k), String(v)])),
      FAM["Plic AWB"], { um: "buc" });
    const c = produseScrise().length ? peColoane(produseScrise()[0]) : {};
    bine("produsul de pe comandă se scrie", creat && id && r.ok, { creat, id });
    bine("primele coloane, în ordinea de dinainte",
      produseScrise()[0] && /^INSERT INTO produse \(cod, cod_generat, denumire, unitate_masura, pret_vanzare, stoc_minim, cod_familie_id,/.test(produseScrise()[0].sql));
    bine("cu prețuri zero, TVA 21% și costurile necunoscute",
      c.pret_vanzare === 0 && c.pret_achizitie === 0 && c.cota_tva === 21 && c.pret_productie === null &&
      c.adaos_lista === null && c.pret_minim === null && c.categorie === null && c.gestiune === null, c);
    bine("denumirea e cea din caracteristici", c.denumire === r.denumire, c.denumire);
  }

  console.log("\nFormularul generic (lib/crud.js)");
  {
    const cuPagina = routerNou();
    registerCrudAdevarat(cuPagina, {
      path: "/lucruri", table: "lucruri", title: "Lucruri", singular: "lucru",
      fields: [{ name: "nume", label: "Nume" }], adaugare: "/lucruri/altfel",
    });
    const fara = routerNou();
    registerCrudAdevarat(fara, { path: "/lucruri", table: "lucruri", title: "Lucruri", singular: "lucru", fields: [{ name: "nume", label: "Nume" }] });

    let r = await cheama(cuPagina, "GET", "/lucruri/nou", null, ADMIN, { familie: "3" });
    bine("cu `adaugare`, „/nou” trimite la pagina modulului, cu ce era după „?”", r.stare === 302 && r.antet.Location === "/lucruri/altfel?familie=3", r.antet);
    BAZA.inserturi = [];
    r = await cheama(cuPagina, "POST", "/lucruri", { nume: "x" }, ADMIN);
    bine("și POST-ul pe listă nu scrie nimic", r.stare === 302 && r.antet.Location === "/lucruri/altfel?vechi=1" && !BAZA.inserturi.length, { a: r.antet, n: BAZA.inserturi.length });
    r = await cheama(cuPagina, "GET", "/lucruri", null, ADMIN, {});
    bine("butonul din listă duce la pagina modulului", /href="\/lucruri\/altfel" class="btn">\+ lucru nou/.test(r.text));

    r = await cheama(fara, "GET", "/lucruri/nou", null, ADMIN, {});
    bine("fără `adaugare`, „/nou” e formularul de până acum", r.stare === 200 && /name="nume"/.test(r.text), r.stare);
    BAZA.inserturi = [];
    r = await cheama(fara, "POST", "/lucruri", { nume: "x" }, ADMIN);
    bine("iar POST-ul scrie rândul", r.stare === 302 && BAZA.inserturi.some((x) => /INSERT INTO lucruri/.test(x.sql)), BAZA.inserturi.map((x) => x.sql));
    r = await cheama(fara, "GET", "/lucruri", null, ADMIN, {});
    bine("cu butonul spre „/nou”", /href="\/lucruri\/nou" class="btn">/.test(r.text));
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
