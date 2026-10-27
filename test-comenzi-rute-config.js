"use strict";
// Rutele produsului configurat din comanda agentului, cu o bază de date
// falsă. Nu atinge Postgres.
//
// CE APĂRĂ:
//
//   • PREVIZUALIZAREA NU SCRIE NIMIC. Se cheamă la fiecare tastă apăsată. Dacă
//     ar scrie, fiecare cifră tastată la grosime ar lăsa un produs în
//     nomenclator.
//
//   • UN PRODUS INCOMPLET NU INTRĂ ÎN NOMENCLATOR. Butonul e dezactivat în
//     pagină, dar ruta se poate chema și direct — regula trebuie să țină și
//     fără browser.
//
//   • DE DOUĂ ORI ACELAȘI PRODUS = ACELAȘI ID. Ăsta e motivul pentru care
//     există codul unic. Dacă a doua comandă ar scrie un al doilea produs cu
//     același cod, stocul s-ar rupe în două și nimeni n-ar mai ști câte pungi
//     de 350×450 avem.
//
//   • RUTELE SUNT ÎNAINTEA LUI /comenzi/:id. Se potrivesc în ordinea
//     înregistrării; invers, „produs-configurat" ar fi citit ca număr de
//     comandă și agentul ar primi „comandă inexistentă".
const Module = require("module");
const path = require("path");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 240) : ""));
    esecuri++;
  }
}

// ---- baza de date falsă ---------------------------------------------------
const { START } = require("./lib/cod-familii");
const pungi = START.find((f) => f[0] === "Pungă curier")[2];

const BAZA = {
  familii: [{ id: 2, nume: "Pungă curier", exemplu: "PCIA35045045", activ: 1, ordine: 2 }],
  caracteristici: pungi.map((c, i) => {
    const [nume, fel, um, ordine, cifre, valori, minv, maxv, inCod, oblig] = c;
    return {
      id: i + 1, familie_id: 2, nume, fel, um: um || null, activ: 1,
      in_cod: inCod === 0 ? 0 : 1, ordine, obligatoriu: oblig === 0 ? 0 : 1,
      cifre: cifre || 0, min_val: minv == null ? null : minv, max_val: maxv == null ? null : maxv,
    };
  }),
  valori: [],
  produse: [],
  scrieri: [],
};
{
  let vid = 0;
  for (const [i, c] of pungi.entries()) {
    for (const [valoare, cod] of c[5] || []) {
      BAZA.valori.push({ id: ++vid, caracteristica_id: i + 1, valoare, cod, ordine: vid, activ: 1 });
    }
  }
}

let urmatorulId = 100;
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      BAZA.scrieri.push(s);
      if (/FROM cod_familii/i.test(s)) return { n: BAZA.familii.length };
      if (/FROM produse WHERE cod_generat/i.test(s)) {
        const cod = String(a[0] || "");
        return BAZA.produse.find((p) => p.cod_generat === cod || String(p.cod || "").toUpperCase() === cod) || undefined;
      }
      if (/FROM produse WHERE id/i.test(s)) return BAZA.produse.find((p) => p.id === Number(a[0]));
      return undefined;
    },
    async all() {
      BAZA.scrieri.push(s);
      if (/FROM cod_familii/i.test(s)) return BAZA.familii;
      if (/FROM cod_caracteristici/i.test(s)) {
        const m = s.match(/familie_id = (\d+)/);
        const f = m ? Number(m[1]) : null;
        return BAZA.caracteristici.filter((c) => (f ? c.familie_id === f : c.familie_id == null) && c.activ);
      }
      if (/FROM cod_valori/i.test(s)) return BAZA.valori;
      if (/FROM parteneri/i.test(s)) return [{ id: 1, nume: "Sameday", cui: "RO1", agent_id: 5 }];
      if (/FROM utilizatori/i.test(s)) return [{ id: 5, nume: "Agent" }];
      if (/FROM produse WHERE activ/i.test(s)) {
        return BAZA.produse.length ? BAZA.produse : [{ id: 1, cod: "X1", denumire: "Produs vechi", pret_vanzare: 10, categorie: "Folii", unitate_masura: "buc" }];
      }
      return [];
    },
    async run(...a) {
      BAZA.scrieri.push(s);
      if (/INSERT INTO produse \(/i.test(s)) {
        const id = ++urmatorulId;
        BAZA.produse.push({
          id, cod: a[0], cod_generat: a[1], denumire: a[2], unitate_masura: a[3],
          pret_vanzare: a[4], categorie: "", activ: 1,
        });
        return { lastInsertRowid: id };
      }
      return { lastInsertRowid: 0 };
    },
  };
}
const dbFals = { prepare: fals, exec: async () => {}, migrate: async () => {} };

// Se bagă în cache ÎNAINTE de a cere modulele, ca `require("../lib/db")` din
// ele să primească obiectul ăsta, nu unul care cere Postgres.
function injecteaza(cale, obiect) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = obiect;
  require.cache[abs] = m;
}
injecteaza("./lib/db", dbFals);

const comenzi = require("./modules/comenzi");
const produse = require("./modules/produse");

// ---- router fals ----------------------------------------------------------
const rute = [];
const routerFals = {
  get: (cale, h) => rute.push(["GET", cale, h]),
  post: (cale, h) => rute.push(["POST", cale, h]),
  use: () => {},
};
comenzi.register(routerFals);
const ruteComenzi = rute.length;
produse.register(routerFals);

function ruta(metoda, cale) {
  const r = rute.find((x) => x[0] === metoda && x[1] === cale);
  if (!r) throw new Error("ruta lipsește: " + metoda + " " + cale);
  return r[2];
}

async function cheama(metoda, cale, corp, user) {
  let stare = 0;
  let text = "";
  const res = {
    writeHead(s) { stare = s; },
    end(t) { text = t == null ? "" : String(t); },
    setHeader() {},
  };
  await ruta(metoda, cale)({ req: {}, res, params: {}, query: {}, body: corp, user });
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { stare, text, json };
}

const AGENT = { id: 5, nume: "Agent", rol: "agent" };
const ADMIN = { id: 1, nume: "Vali", rol: "admin" };

const dupaNume = new Map(BAZA.caracteristici.map((c) => [c.nume, c.id]));
const COMPLET = { familie: 2 };
for (const [n, v] of Object.entries({
  Tip: "Pungă curier", Imprimare: "Imprimată", "Culoare folie": "Alb", "Lățime": 350,
  "Lungime fără clapetă": 450, Grosime: 45, "Clapetă": 50, "Tip închidere": "Bandă adezivă",
})) COMPLET["c_" + dupaNume.get(n)] = v;

(async () => {
  console.log("Ordinea rutelor");
  {
    const idx = (m, c) => rute.findIndex((x) => x[0] === m && x[1] === c);
    bine("POST /comenzi/produs-configurat e înaintea lui /comenzi/:id",
      idx("POST", "/comenzi/produs-configurat") < ruteComenzi &&
      idx("POST", "/comenzi/produs-configurat") < idx("POST", "/comenzi/:id/valideaza"));
    bine("și ruta de scriere la fel",
      idx("POST", "/comenzi/produs-configurat/creeaza") < idx("POST", "/comenzi/:id/valideaza"));
  }

  console.log("\nPrevizualizarea");
  {
    BAZA.scrieri = [];
    const r = await cheama("POST", "/comenzi/produs-configurat", { familie: 2, ["c_" + dupaNume.get("Tip")]: "Pungă curier" }, AGENT);
    bine("răspunde 200", r.stare === 200, r);
    bine("nu scoate cod cât timp lipsesc caracteristici", !r.json.sePoate, r.json);
    bine("spune ce lipsește", (r.json.rezumat || "").indexOf("mai lipsește") !== -1, r.json.rezumat);
    bine("NU scrie nimic în bază", !BAZA.scrieri.some((s) => /^INSERT/i.test(s)), BAZA.scrieri.filter((s) => /^INSERT/i.test(s)));
    bine("și niciun produs n-a apărut", BAZA.produse.length === 0);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat", COMPLET, AGENT);
    bine("completat, scoate codul cerut", r.json.cod === "PCIA35045045", r.json);
    bine("și se poate pune pe comandă", r.json.sePoate === true);
    bine("cu denumirea scrisă singură", (r.json.denumire || "").length > 10, r.json.denumire);
    bine("tot fără să scrie ceva", BAZA.produse.length === 0);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat", {}, AGENT);
    bine("fără familie aleasă nu crapă", r.stare === 200 && r.json.sePoate === false, r);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat", COMPLET, null);
    bine("neautentificat nu trece", r.stare === 403, r.stare);
  }

  console.log("\nScrierea produsului");
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      { familie: 2, ["c_" + dupaNume.get("Tip")]: "Pungă curier" }, AGENT);
    bine("produsul incomplet e refuzat", r.stare === 400, r);
    bine("și motivul e scris pe înțelesul agentului",
      (r.json.eroare || "").indexOf("Pungă curier") !== -1 && (r.json.eroare || "").indexOf("mai lipsește") !== -1,
      r.json.eroare);
    bine("nimic n-a intrat în nomenclator", BAZA.produse.length === 0);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza", { familie: 2 }, AGENT);
    bine("linia goală trimite agentul la catalog", (r.json.eroare || "").indexOf("catalog") !== -1, r.json.eroare);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza", { ...COMPLET, um: "buc" }, AGENT);
    bine("produsul complet se scrie", r.stare === 200 && Number(r.json.id) > 0, r);
    bine("cu codul generat pe el", r.json.cod === "PCIA35045045", r.json);
    bine("un singur produs în nomenclator", BAZA.produse.length === 1, BAZA.produse);
    const p = BAZA.produse[0];
    bine("codul e scris și în `cod`, și în `cod_generat`", p.cod === "PCIA35045045" && p.cod_generat === "PCIA35045045", p);
    bine("unitatea aleasă pe linie merge pe produs", p.unitate_masura === "buc", p.unitate_masura);
  }
  {
    // Miezul: a doua oară trebuie sa cada pe ACELASI produs.
    const primul = BAZA.produse[0].id;
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza", { ...COMPLET, um: "kg" }, AGENT);
    bine("a doua oară cade pe același produs", Number(r.json.id) === primul, { avut: r.json.id, asteptat: primul });
    bine("și nu s-a mai scris unul", BAZA.produse.length === 1, BAZA.produse.length);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza",
      { ...COMPLET, ["c_" + dupaNume.get("Lățime")]: 3500 }, AGENT);
    bine("o lățime cu un zero în plus e refuzată", r.stare === 400, r);
    bine("și spune că nu încape", (r.json.eroare || "").indexOf("cifre") !== -1, r.json.eroare);
    bine("nomenclatorul a rămas curat", BAZA.produse.length === 1);
  }
  {
    const r = await cheama("POST", "/comenzi/produs-configurat/creeaza", { ...COMPLET, familie: 99 }, AGENT);
    bine("o familie inexistentă e refuzată", r.stare === 400, r);
  }

  console.log("\nProdusul liber rămâne doar la admin");
  {
    const r = await cheama("POST", "/produse/rapid", { denumire: "ceva scris de mână" }, AGENT);
    bine("agentul nu mai scrie produse dintr-o denumire", r.stare === 403, r);
    bine("și i se spune ce să apese", (r.json.eroare || "").indexOf("configurează") !== -1, r.json.eroare);
    const a = await cheama("POST", "/produse/rapid", { denumire: "ceva scris de mână" }, ADMIN);
    bine("adminul trece de verificarea de rol", a.stare !== 403, a.stare);
  }

  console.log("\nFormularul se desenează");
  {
    let corp = "";
    const res = { writeHead() {}, end(t) { corp = String(t || ""); }, setHeader() {} };
    await ruta("GET", "/comenzi/nou")({ req: {}, res, params: {}, query: {}, body: {}, user: AGENT });
    bine("pagina se construiește", corp.length > 2000, corp.length);
    bine("familiile ajung în pagină ca date", corp.indexOf("COMENZI_FAMILII") !== -1);
    bine("cu caracteristicile lor", corp.indexOf("Tip închidere") !== -1 || corp.indexOf("Tip \\u00eenchidere") !== -1);
    bine("butonul de configurare e acolo", corp.indexOf("configurează-l") !== -1);
    bine("agentul NU vede butonul de produs liber", corp.indexOf("COMENZI_ADMIN = false") !== -1, corp.indexOf("COMENZI_ADMIN"));
    // `</script>` scris in date ar inchide blocul si ar sparge pagina.
    const intreScript = corp.slice(corp.indexOf("COMENZI_FAMILII"), corp.indexOf("COMENZI_ADMIN"));
    bine("datele nu pot închide blocul de script", intreScript.indexOf("</") === -1);

    let corpAdmin = "";
    const res2 = { writeHead() {}, end(t) { corpAdmin = String(t || ""); }, setHeader() {} };
    await ruta("GET", "/comenzi/nou")({ req: {}, res: res2, params: {}, query: {}, body: {}, user: ADMIN });
    bine("adminul îl vede", corpAdmin.indexOf("COMENZI_ADMIN = true") !== -1);
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("CRAPAT:", e && e.stack ? e.stack : e);
  process.exit(1);
});
