"use strict";
// Hârtia (cutie / top) și personalizarea benzii adezive, pe rutele adevărate,
// cu o bază de date falsă. Nu atinge Postgres.
//
// Cererile lui Vali, 03.11.2026:
//   „La configurați banda adezivă trebuie să adăugăm și personalizat sau nu,
//    iar la personalizat e custom și câte culori sau fragil."
//   „La produse hârtie produs nou și acolo configurare și în lista derulantă
//    să fie cutie sau top, care înseamnă 5 topuri per cutie."
//
// CE APĂRĂ:
//
//   • UNITATEA DE MĂSURĂ VINE DIN „CUTIE / TOP", NU DIN CĂSUȚĂ. Căsuța de UM
//     pornește cu „buc" la Produs nou, iar pe comandă agentul poate să fi
//     scris „cutie" înainte să aleagă „Top". Un top scris „cutie" înseamnă
//     cinci topuri facturate la prețul unuia.
//
//   • BANDA NEPERSONALIZATĂ CADE PE PRODUSUL DE ACUM. Codul ei e cel de
//     dinainte (BALT4890045), deci comanda trebuie să găsească produsul
//     existent, nu să scrie unul nou lângă el.
//
//   • PERSONALIZAREA E CERUTĂ. Fără ea, comanda e refuzată cu numele
//     câmpului, nu cu un cod scurt care se lovește de al altei benzi.
//
//   • UM-UL SE PĂSTREAZĂ ȘI CÂND SE ADAUGĂ VALORI DIN CONFIGURĂRI, și nu se
//     mută de pe un rând pe altul când formularul vine dintr-o pagină veche,
//     fără căsuța de UM.
//
//   • LA O BAZĂ GOALĂ, FAMILIILE SE PUN CU TOT CU UM ȘI CU „NEPERSONALIZATĂ"
//     FĂRĂ BUCATĂ.
const Module = require("module");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 260) : ""));
    esecuri++;
  }
}

const { START } = require("./lib/cod-familii");
const FAM = { "Bandă adezivă": 6, "Hârtie": 9 };

const BAZA = { familii: [], caracteristici: [], valori: [], produse: [], scrieri: [], inserturi: [], goala: false };
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
// Banda simplă care există deja în nomenclator, cu codul ei de dinainte.
BAZA.produse.push({ id: 50, cod: "BALT4890045", cod_generat: "BALT4890045", denumire: "Bandă adezivă 48×900 LN",
  unitate_masura: "rolă", pret_vanzare: 7.1, categorie: "Benzi", activ: 1 });

let urmatorulId = 100;
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      BAZA.scrieri.push(s);
      if (/SELECT COUNT\(\*\) AS n FROM cod_familii/i.test(s)) return { n: BAZA.goala ? 0 : BAZA.familii.length };
      if (/COUNT\(\*\) AS n FROM cod_caracteristici WHERE familie_id IS NULL/i.test(s)) return { n: 0 };
      if (/COUNT\(\*\) AS n FROM cod_valori WHERE caracteristica_id/i.test(s)) {
        return { n: BAZA.valori.filter((v) => v.caracteristica_id === Number(a[0])).length };
      }
      if (/FROM produse x WHERE x\.cod_generat/i.test(s)) {
        const cod = String(a[0] || "");
        return BAZA.produse.find((p) => p.cod_generat === cod || String(p.cod || "").trim().toUpperCase() === cod);
      }
      if (/FROM produse WHERE id/i.test(s)) return BAZA.produse.find((p) => p.id === Number(a[0]));
      return undefined;
    },
    async all(...a) {
      BAZA.scrieri.push(s);
      if (/FROM cod_familii/i.test(s)) return BAZA.familii;
      if (/FROM cod_caracteristici/i.test(s)) {
        const m = s.match(/familie_id = (\d+)/);
        const f = m ? Number(m[1]) : null;
        const toate = !/activ = 1/.test(s);
        return BAZA.caracteristici.filter((c) => (f ? c.familie_id === f : c.familie_id == null) && (toate || c.activ));
      }
      if (/SELECT valoare, cod FROM cod_valori WHERE caracteristica_id/i.test(s)) {
        return BAZA.valori.filter((v) => v.caracteristica_id === Number(a[0]));
      }
      if (/FROM cod_valori/i.test(s)) return BAZA.valori;
      if (/FROM parteneri/i.test(s)) return [{ id: 1, nume: "Client", cui: "RO1", agent_id: 5 }];
      if (/FROM utilizatori/i.test(s)) return [{ id: 5, nume: "Agent" }];
      if (/FROM produse WHERE activ/i.test(s)) return BAZA.produse;
      return [];
    },
    async run(...a) {
      BAZA.scrieri.push(s);
      if (/^INSERT/i.test(s)) BAZA.inserturi.push({ sql: s, a });
      if (/INSERT INTO produse \(/i.test(s)) {
        const id = ++urmatorulId;
        BAZA.produse.push({ id, cod: a[0], cod_generat: a[1], denumire: a[2], unitate_masura: a[3],
          pret_vanzare: a[4], categorie: "", activ: 1 });
        return { lastInsertRowid: id };
      }
      if (/INSERT INTO cod_familii|INSERT INTO cod_caracteristici/i.test(s)) return { lastInsertRowid: ++urmatorulId };
      return { lastInsertRowid: 0 };
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

const codProdus = require("./modules/cod-produs");
const comenzi = require("./modules/comenzi");

const rute = [];
const routerFals = {
  get: (cale, h) => rute.push(["GET", cale, h]),
  post: (cale, h) => rute.push(["POST", cale, h]),
  use: () => {},
};
codProdus.register(routerFals);
comenzi.register(routerFals);

async function cheama(metoda, cale, corp, user, query) {
  const r = rute.find((x) => x[0] === metoda && x[1] === cale);
  if (!r) throw new Error("ruta lipsește: " + metoda + " " + cale);
  let stare = 0;
  let text = "";
  let antet = {};
  const res = {
    writeHead(st, h) { stare = st; antet = h || {}; },
    end(t) { text = t == null ? "" : String(t); },
    setHeader() {},
  };
  await r[2]({ req: {}, res, params: {}, query: query || {}, body: corp, user });
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { stare, text, json, antet };
}

const AGENT = { id: 5, nume: "Agent", rol: "agent" };
const ADMIN = { id: 1, nume: "Vali", rol: "admin" };
const idCar = (fam, nume) => BAZA.caracteristici.find((c) => c.familie_id === FAM[fam] && c.nume === nume).id;
function corp(fam, alegeri, extra) {
  const o = { familie: FAM[fam], ...(extra || {}) };
  for (const [k, v] of Object.entries(alegeri)) o["c_" + idCar(fam, k)] = v;
  return o;
}
const HARTIE = { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80 };
const BANDA = { Tip: "Bandă adezivă", Zgomot: "Low noise", Culoare: "Transparent", "Lățime": 48,
                "Lungime rolă": 900, Grosime: 45, "Diametru core": 47 };
const produseScrise = () => BAZA.inserturi.filter((x) => /INSERT INTO produse \(/i.test(x.sql));

(async () => {
  console.log("Hârtia pe comandă");
  {
    BAZA.inserturi = [];
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Hârtie", { ...HARTIE, Ambalare: "Top" }, { um: "cutie" }), AGENT);
    const p = BAZA.produse.find((x) => x.id === (r.json && r.json.id));
    bine("topul se pune pe comandă", r.stare === 200 && r.json && r.json.id, r);
    bine("cu codul HCA4080T", r.json && r.json.cod === "HCA4080T", r.json);
    bine("produsul se scrie cu UM top, deși pe linie scria „cutie”", p && p.unitate_masura === "top", p);
    bine("pagina primește UM top și știe că vine din caracteristici",
      r.json && r.json.um === "top" && r.json.umFix === true, r.json);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Hârtie", { ...HARTIE, Ambalare: "Cutie (5 topuri)" }, { um: "" }), AGENT);
    const p = BAZA.produse.find((x) => x.id === (r.json && r.json.id));
    bine("cutia e alt produs decât topul", r.json && r.json.cod === "HCA4080C" && p, r.json);
    bine("cu UM cutie", p && p.unitate_masura === "cutie", p);
    bine("și în denumire scrie „Cutie (5 topuri)”", p && /Cutie \(5 topuri\)/.test(p.denumire), p && p.denumire);
  }
  {
    const inainte = produseScrise().length;
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Hârtie", { ...HARTIE, Ambalare: "Top" }, { um: "" }), AGENT);
    bine("a doua comandă de top cade pe același produs",
      r.json && r.json.cod === "HCA4080T" && produseScrise().length === inainte, { r: r.json, scrise: produseScrise().length - inainte });
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat", corp("Hârtie", HARTIE), AGENT);
    bine("fără cutie/top previzualizarea spune că lipsește ambalarea",
      r.json && !r.json.sePoate && /Ambalare/.test(r.json.rezumat || ""), r.json);
  }

  console.log("\nBanda adezivă pe comandă");
  {
    const inainte = produseScrise().length;
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Bandă adezivă", { ...BANDA, Personalizare: "Nepersonalizată" }, { um: "" }), AGENT);
    bine("nepersonalizată cade pe banda care există deja (id 50)", r.json && r.json.id === 50, r.json);
    bine("și nu scrie produs nou", produseScrise().length === inainte);
    bine("UM-ul rămâne al produsului, nu e impus", r.json && r.json.um === "rolă" && r.json.umFix === false, r.json);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Bandă adezivă", { ...BANDA, Personalizare: "Personalizată FRAGIL" }, { um: "rolă" }), AGENT);
    const p = BAZA.produse.find((x) => x.id === (r.json && r.json.id));
    bine("FRAGIL e produs nou, BALT4890045F", r.json && r.json.cod === "BALT4890045F" && p && p.id !== 50, r.json);
    bine("cu UM-ul scris de agent", p && p.unitate_masura === "rolă", p);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      corp("Bandă adezivă", { ...BANDA, Personalizare: "Personalizată custom 3 culori" }, { um: "rolă" }), AGENT);
    bine("custom cu 3 culori, BALT4890045C3", r.json && r.json.cod === "BALT4890045C3", r.json);
  }
  {
    const inainte = produseScrise().length;
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza", corp("Bandă adezivă", BANDA, { um: "rolă" }), AGENT);
    bine("fără personalizare aleasă e refuzată", r.stare === 400 && r.json && /Personalizare/.test(r.json.eroare || ""), r);
    bine("și nu scrie nimic", produseScrise().length === inainte);
    const p = await cheama("POST", "/comenzi/produs-configurat", corp("Bandă adezivă", BANDA), AGENT);
    bine("iar în previzualizare butonul rămâne oprit, deși codul seamănă cu al benzii simple",
      p.json && p.json.sePoate === false && /Personalizare/.test(p.json.rezumat || ""), p.json);
  }

  console.log("\nProdus nou din nomenclator");
  {
    const r = await cheama("POST", "/produse/nou-cu-cod/preview",
      { __familie: String(FAM["Hârtie"]), [idCar("Hârtie", "Tip")]: "Hârtie copiator", [idCar("Hârtie", "Format")]: "A3",
        [idCar("Hârtie", "Gramaj")]: "80", [idCar("Hârtie", "Ambalare")]: "Top" }, ADMIN);
    bine("previzualizarea trimite UM top în pagină", r.json && r.json.um === "top" && r.json.cod === "HCA3080T", r.json);
  }
  {
    const b = { familie: String(FAM["Hartie"] || FAM["Hârtie"]), unitate_masura: "buc", pret_vanzare: "60", stoc_minim: "0" };
    for (const [k, v] of Object.entries({ Tip: "Hârtie copiator", Format: "A3", Gramaj: "80", Ambalare: "Cutie (5 topuri)" })) {
      b["c_" + idCar("Hârtie", k)] = v;
    }
    const r = await cheama("POST", "/produse/nou-cu-cod", b, ADMIN);
    const p = BAZA.produse.find((x) => x.cod_generat === "HCA3080C");
    bine("produsul se scrie și duce la fișa lui", r.stare === 302 && p && r.antet.Location === "/produse/" + p.id, { stare: r.stare, antet: r.antet });
    bine("cu UM cutie, deși în căsuță rămăsese „buc”", p && p.unitate_masura === "cutie", p);
  }
  {
    const b = { familie: String(FAM["Bandă adezivă"]), unitate_masura: "bax", pret_vanzare: "0", stoc_minim: "0" };
    for (const [k, v] of Object.entries({ ...BANDA, Personalizare: "Personalizată custom 1 culoare" })) b["c_" + idCar("Bandă adezivă", k)] = String(v);
    await cheama("POST", "/produse/nou-cu-cod", b, ADMIN);
    const p = BAZA.produse.find((x) => x.cod_generat === "BALT4890045C1");
    bine("la bandă rămâne UM-ul scris în căsuță", p && p.unitate_masura === "bax", p);
  }

  console.log("\nConfigurări");
  {
    const r = await cheama("GET", "/configurari/cod-produs", null, ADMIN, { familie: String(FAM["Bandă adezivă"]) });
    bine("„Nepersonalizată” se vede ca „nimic în cod”, nu ca o bucată goală",
      /nimic în cod<\/span> Nepersonalizată/.test(r.text), r.text.match(/.{60}Nepersonalizată.{20}/));
    bine("exemplul de cod nu are „?”", !/BALT\S*\?/.test(r.text));
  }
  {
    const r = await cheama("GET", "/configurari/cod-produs", null, ADMIN, { familie: String(FAM["Hârtie"]) });
    bine("la hârtie se vede UM-ul fiecărei valori",
      /Cutie \(5 topuri\) <span class="badge">UM cutie<\/span>/.test(r.text) && /Top <span class="badge">UM top<\/span>/.test(r.text));
    bine("formularul de valori are căsuța de UM", /name="um\[\]"/.test(r.text));
  }
  {
    const cid = idCar("Hârtie", "Format");
    BAZA.inserturi = [];
    await cheama("POST", "/configurari/cod-produs/valoare",
      { caracteristica_id: String(cid), familie_id: String(FAM["Hârtie"]),
        "valoare[]": ["A5", "Bax"], "cod[]": ["A5", "B"], "um[]": ["", "bax"] }, ADMIN);
    const ins = BAZA.inserturi.filter((x) => /INSERT INTO cod_valori/i.test(x.sql));
    bine("valorile noi se scriu amândouă", ins.length === 2, ins);
    bine("UM-ul scris se păstrează („bax”), cel gol rămâne gol",
      ins.length === 2 && ins[0].a[4] === null && ins[1].a[4] === "bax", ins.map((x) => x.a));
  }
  {
    const cid = idCar("Hârtie", "Format");
    BAZA.inserturi = [];
    // O pagină veche, deschisă de dinainte: fără căsuța de UM.
    await cheama("POST", "/configurari/cod-produs/valoare",
      { caracteristica_id: String(cid), familie_id: String(FAM["Hârtie"]), "valoare[]": ["A6"], "cod[]": ["A6"] }, ADMIN);
    const ins = BAZA.inserturi.filter((x) => /INSERT INTO cod_valori/i.test(x.sql));
    bine("din pagina veche se scrie fără UM", ins.length === 1 && ins[0].a[4] === null, ins.map((x) => x.a));
  }
  {
    const cid = idCar("Hârtie", "Format");
    BAZA.inserturi = [];
    // Un rând gol la mijloc: UM-ul rândului 3 nu are voie să alunece pe rândul 2.
    await cheama("POST", "/configurari/cod-produs/valoare",
      { caracteristica_id: String(cid), familie_id: String(FAM["Hârtie"]),
        "valoare[]": ["B4", "", "B5"], "cod[]": ["B4", "", "B5"], "um[]": ["", "", "top"] }, ADMIN);
    const ins = BAZA.inserturi.filter((x) => /INSERT INTO cod_valori/i.test(x.sql));
    bine("cu un rând gol la mijloc, UM-ul rămâne pe rândul lui",
      ins.length === 2 && ins[0].a[1] === "B4" && ins[0].a[4] === null && ins[1].a[1] === "B5" && ins[1].a[4] === "top",
      ins.map((x) => x.a));
  }
  {
    const cid = idCar("Hârtie", "Format");
    BAZA.inserturi = [];
    // Mai puține UM-uri decât rânduri: nu se știe al cui e, deci nu se pune
    // pe niciunul — mai bine gol decât pe valoarea greșită.
    await cheama("POST", "/configurari/cod-produs/valoare",
      { caracteristica_id: String(cid), familie_id: String(FAM["Hârtie"]),
        "valoare[]": ["C4", "C5"], "cod[]": ["C4", "C5"], "um[]": "top" }, ADMIN);
    const ins = BAZA.inserturi.filter((x) => /INSERT INTO cod_valori/i.test(x.sql));
    bine("un UM care nu se știe al cărui rând e nu se pune pe niciunul",
      ins.length === 2 && ins.every((x) => x.a[4] === null), ins.map((x) => x.a));
  }

  console.log("\nLa o bază goală");
  {
    BAZA.goala = true;
    BAZA.inserturi = [];
    await codProdus.seed();
    BAZA.goala = false;
    const val = BAZA.inserturi.filter((x) => /INSERT INTO cod_valori/i.test(x.sql));
    const cutie = val.find((x) => x.a[1] === "Cutie (5 topuri)");
    const top = val.find((x) => x.a[1] === "Top");
    const nepers = val.find((x) => x.a[1] === "Nepersonalizată");
    const fam = BAZA.inserturi.filter((x) => /INSERT INTO cod_familii/i.test(x.sql)).map((x) => x.a[0]);
    bine("se pun toate cele nouă familii, și hârtia printre ele", fam.length === 9 && fam.includes("Hârtie"), fam);
    bine("cutia se pune cu UM cutie, topul cu UM top", cutie && cutie.a[4] === "cutie" && top && top.a[4] === "top",
      [cutie && cutie.a, top && top.a]);
    bine("„Nepersonalizată” se pune fără bucată de cod", nepers && nepers.a[2] === "", nepers && nepers.a);
    bine("valorile fără UM se pun cu UM gol", val.filter((x) => x.a[4] !== null).length === 2, val.filter((x) => x.a[4] !== null).map((x) => x.a));
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
