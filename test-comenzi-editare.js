"use strict";
// Modificarea unei comenzi, prin rutele adevărate, cu o bază de date falsă.
//
// CE APĂRĂ:
//
//   • STRĂINUL NU TRECE NICI PRIN UȘA DIN SPATE. Butonul „Modifică" nu apare
//     pentru cine n-are voie — dar ruta se poate chema și direct. Regula
//     trebuie să țină pe server, nu în pagină.
//
//   • ORICE SALVARE LASĂ URMĂ. Dacă scrierea în istoric ar putea fi sărită,
//     tot ce urmează e teatru: comanda s-ar schimba și nimeni n-ar ști de cine.
//
//   • O SALVARE FĂRĂ SCHIMBĂRI NU MURDĂREȘTE ISTORICUL. Cine deschide
//     formularul și apasă „Salvează" fără să atingă nimic nu trebuie să lase
//     un rând. Un istoric plin de rânduri goale nu mai e citit de nimeni.
//
//   • CANTITATEA LIVRATĂ NU SE PIERDE LA O CORECTURĂ DE PREȚ. Depozitul a
//     scris acolo ce-a ieșit pe ușă. Dacă liniile s-ar șterge și rescrie,
//     cifra aia ar dispărea în tăcere, iar comanda ar părea nelivrată.
//
//   • COMANDA NU POATE FI GOLITĂ. O comandă fără linii n-are ce căuta nici în
//     depozit, nici pe factură.
const Module = require("module");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 260) : ""));
    esecuri++;
  }
}

// ---- baza falsă -----------------------------------------------------------
const BAZA = {
  comenzi: [
    { id: 5, partener_id: 3, numar: "CMD-5", data: "2026-10-20", status: "noua", observatii: "urgent",
      agent_id: 11, moneda: "RON", livrare_partiala: "da", data_livrare_ceruta: "2026-11-02", factura_id: null },
  ],
  parteneri: [
    { id: 3, nume: "Sameday Courier SRL", cui: "RO1", agent_id: 22, tip: "client" },
    { id: 4, nume: "Delivery Solutions SA", cui: "RO2", agent_id: 22, tip: "client" },
  ],
  linii: [
    { id: 90, comanda_id: 5, produs_id: 1, cantitate: 20000, pret_unitar: 0.42, um: "buc", cantitate_livrata: 5000 },
    { id: 91, comanda_id: 5, produs_id: 2, cantitate: 100, pret_unitar: 7.1, um: "buc", cantitate_livrata: 0 },
  ],
  produse: [
    { id: 1, cod: "PCIA35045045", denumire: "Pungă curier 350×450", pret_vanzare: 0.42, categorie: "Pungi", unitate_masura: "buc", activ: 1 },
    { id: 2, cod: "BALT4890045", denumire: "Bandă adezivă 48×900", pret_vanzare: 7.1, categorie: "Benzi", unitate_masura: "buc", activ: 1 },
    { id: 3, cod: "FSMA10200", denumire: "Folie stretch 10×200", pret_vanzare: 23.5, categorie: "Folii", unitate_masura: "rolă", activ: 1 },
  ],
  istoric: [],
  stersePe: [],
};
let urmId = 500;

function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      if (/FROM comenzi c JOIN parteneri/i.test(s)) {
        const c = BAZA.comenzi.find((x) => x.id === Number(a[0]));
        if (!c) return undefined;
        const p = BAZA.parteneri.find((x) => x.id === c.partener_id);
        return { ...c, partener_nume: p ? p.nume : "" };
      }
      if (/FROM parteneri WHERE id/i.test(s)) return BAZA.parteneri.find((x) => x.id === Number(a[0]));
      if (/FROM produse WHERE id/i.test(s)) return BAZA.produse.find((x) => x.id === Number(a[0]));
      if (/COUNT\(\*\)/i.test(s)) return { n: 0 };
      return undefined;
    },
    async all(...a) {
      if (/FROM comenzi_istoric/i.test(s)) {
        return BAZA.istoric.filter((h) => h.comanda_id === Number(a[0])).slice().reverse();
      }
      if (/FROM comenzi_linii cl JOIN produse/i.test(s)) {
        return BAZA.linii
          .filter((l) => l.comanda_id === Number(a[0]))
          .map((l) => ({ ...l, denumire: (BAZA.produse.find((p) => p.id === l.produs_id) || {}).denumire }));
      }
      if (/FROM comenzi_linii/i.test(s)) return BAZA.linii.filter((l) => l.comanda_id === Number(a[0]));
      if (/FROM parteneri/i.test(s)) return BAZA.parteneri;
      if (/FROM utilizatori/i.test(s)) return [{ id: 11, nume: "Agent Unu" }, { id: 22, nume: "Owner Client" }];
      if (/FROM produse WHERE activ/i.test(s)) return BAZA.produse;
      if (/FROM cod_familii/i.test(s)) return [];
      return [];
    },
    async run(...a) {
      if (/INSERT INTO comenzi_istoric/i.test(s)) {
        BAZA.istoric.push({
          id: ++urmId, comanda_id: a[0], utilizator_id: a[1], utilizator_nume: a[2],
          ce: a[3], vechi: a[4], nou: a[5], la: "2026-10-27 09:00:00",
        });
        return { lastInsertRowid: urmId };
      }
      if (/UPDATE comenzi SET partener_id/i.test(s)) {
        const c = BAZA.comenzi.find((x) => x.id === Number(a[6]));
        Object.assign(c, { partener_id: a[0], numar: a[1], observatii: a[2], data_livrare_ceruta: a[3], livrare_partiala: a[4], moneda: a[5] });
        return {};
      }
      if (/UPDATE comenzi_linii SET/i.test(s)) {
        const l = BAZA.linii.find((x) => x.id === Number(a[3]));
        if (l) Object.assign(l, { cantitate: a[0], pret_unitar: a[1], um: a[2] });
        return {};
      }
      if (/INSERT INTO comenzi_linii/i.test(s)) {
        BAZA.linii.push({ id: ++urmId, comanda_id: a[0], produs_id: a[1], cantitate: a[2], pret_unitar: a[3], um: a[4], cantitate_livrata: 0 });
        return { lastInsertRowid: urmId };
      }
      if (/DELETE FROM comenzi_linii/i.test(s)) {
        BAZA.stersePe.push(Number(a[0]));
        BAZA.linii = BAZA.linii.filter((l) => l.id !== Number(a[0]));
        return {};
      }
      return { lastInsertRowid: 0 };
    },
  };
}
function injecteaza(cale, obiect) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null); m.filename = abs; m.loaded = true; m.exports = obiect;
  require.cache[abs] = m;
}
injecteaza("./lib/db", { prepare: fals, exec: async () => {}, migrate: async () => {} });

const comenzi = require("./modules/comenzi");
const rute = [];
comenzi.register({ get: (c, h) => rute.push(["GET", c, h]), post: (c, h) => rute.push(["POST", c, h]), use: () => {} });
function ruta(m, c) {
  const r = rute.find((x) => x[0] === m && x[1] === c);
  if (!r) throw new Error("ruta lipsește: " + m + " " + c);
  return r[2];
}
async function cheama(metoda, cale, params, corp, user) {
  let stare = 200, text = "", unde = null;
  const res = {
    writeHead(s, h) { stare = s; if (h && h.Location) unde = h.Location; },
    end(t) { text = t == null ? "" : String(t); },
    setHeader(k, v) { if (String(k).toLowerCase() === "location") unde = v; },
  };
  await ruta(metoda, cale)({ req: {}, res, params: params || {}, query: {}, body: corp || {}, user });
  return { stare, text, unde };
}

const ADMIN = { id: 1, nume: "Vali", rol: "admin" };
const AGENT_COMENZII = { id: 11, nume: "Agent Unu", rol: "agent" };
const OWNER_CLIENT = { id: 22, nume: "Owner Client", rol: "agent" };
const STRAIN = { id: 77, nume: "Alt Agent", rol: "agent" };
const DEPOZIT = { id: 78, nume: "Depozit", rol: "depozit" };

const formular = (linii, extra) => ({
  partener_id: "3", numar: "CMD-5", data_livrare_ceruta: "2026-11-02",
  livrare_partiala: "da", moneda: "RON", observatii: "urgent",
  "produs_id[]": linii.map((l) => String(l[0])),
  "cantitate[]": linii.map((l) => String(l[1])),
  "pret_unitar[]": linii.map((l) => String(l[2])),
  "um[]": linii.map((l) => l[3] || "buc"),
  ...(extra || {}),
});
const CA_ACUM = [[1, 20000, 0.42], [2, 100, 7.1]];

(async () => {
  console.log("Cine ajunge la formular");
  {
    for (const [cine, u, poate] of [
      ["adminul", ADMIN, true],
      ["agentul comenzii", AGENT_COMENZII, true],
      ["ownerul clientului", OWNER_CLIENT, true],
      ["un agent străin", STRAIN, false],
      ["depozitul", DEPOZIT, false],
    ]) {
      const r = await cheama("GET", "/comenzi/:id/editare", { id: "5" }, {}, u);
      bine(cine + (poate ? " intră" : " primește 403"), poate ? r.stare === 200 : r.stare === 403, r.stare);
    }
    const r = await cheama("GET", "/comenzi/:id/editare", { id: "999" }, {}, ADMIN);
    bine("o comandă inexistentă dă 404", r.stare === 404, r.stare);
  }

  console.log("\nUșa din spate: POST direct");
  {
    const inainte = BAZA.comenzi[0].numar;
    const r = await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular(CA_ACUM, { numar: "FURAT" }), STRAIN);
    bine("străinul e oprit și pe POST", r.stare === 403, r.stare);
    bine("și comanda a rămas neatinsă", BAZA.comenzi[0].numar === inainte, BAZA.comenzi[0].numar);
    bine("fără rând în istoric", BAZA.istoric.length === 0, BAZA.istoric);
  }

  console.log("\nSalvare fără nicio schimbare");
  {
    const r = await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular(CA_ACUM), OWNER_CLIENT);
    bine("trece, dar nu scrie nimic în istoric", BAZA.istoric.length === 0, BAZA.istoric);
    bine("și spune că n-a fost nimic de schimbat", String(r.unde || "").indexOf("ok=nimic") !== -1, r.unde);
  }

  console.log("\nOwnerul clientului chiar modifică");
  {
    const r = await cheama(
      "POST", "/comenzi/:id/editare", { id: "5" },
      formular([[1, 25000, 0.42], [2, 100, 7.5], [3, 10, 23.5, "rolă"]], { observatii: "mărit la telefon", motiv: "clientul a sunat" }),
      OWNER_CLIENT
    );
    bine("salvarea trece", String(r.unde || "").indexOf("ok=modificat") !== -1, r.unde);
    const ce = BAZA.istoric.map((h) => h.ce);
    bine("cantitatea mărită e în istoric", ce.some((x) => x.indexOf("Cantitate") === 0), ce);
    bine("prețul schimbat e în istoric", ce.some((x) => x.indexOf("Preț") === 0), ce);
    bine("linia nouă e în istoric", ce.some((x) => x.indexOf("Linie adăugată") === 0), ce);
    bine("observațiile schimbate sunt în istoric", ce.indexOf("Observații") !== -1, ce);
    bine("motivul scris de om e în istoric", ce.indexOf("Motivul modificării") !== -1, ce);
    bine("fiecare rând poartă NUMELE omului, nu doar id-ul",
      BAZA.istoric.every((h) => h.utilizator_nume === "Owner Client"), BAZA.istoric.map((h) => h.utilizator_nume));
    bine("și id-ul lui", BAZA.istoric.every((h) => h.utilizator_id === 22));
    bine("comanda chiar s-a schimbat în bază", BAZA.comenzi[0].observatii === "mărit la telefon", BAZA.comenzi[0]);
    bine("linia are cantitatea nouă", BAZA.linii.find((l) => l.produs_id === 1).cantitate === 25000);
    bine("linia nouă s-a scris", BAZA.linii.some((l) => l.produs_id === 3), BAZA.linii.map((l) => l.produs_id));

    // Miezul: depozitul scrisese ca au iesit 5000 de bucati.
    bine("CANTITATEA LIVRATĂ n-a fost ștearsă de corectură",
      BAZA.linii.find((l) => l.produs_id === 1).cantitate_livrata === 5000,
      BAZA.linii.find((l) => l.produs_id === 1));
    bine("linia neatinsă n-a fost ștearsă și rescrisă", BAZA.stersePe.indexOf(90) === -1, BAZA.stersePe);
  }

  console.log("\nO linie scoasă");
  {
    const nAinte = BAZA.istoric.length;
    await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular([[1, 25000, 0.42], [3, 10, 23.5, "rolă"]]), ADMIN);
    const noi = BAZA.istoric.slice(nAinte).map((h) => h.ce);
    bine("ștergerea liniei e scrisă", noi.some((x) => x.indexOf("Linie ștearsă") === 0), noi);
    bine("și banda chiar a dispărut", !BAZA.linii.some((l) => l.produs_id === 2), BAZA.linii.map((l) => l.produs_id));
    bine("istoricul vechi n-a fost atins", BAZA.istoric.length > nAinte && BAZA.istoric[0].ce.length > 0);
  }

  console.log("\nCe nu se poate");
  {
    const nAinte = BAZA.istoric.length;
    const cateLinii = BAZA.linii.length;
    const r = await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular([]), ADMIN);
    bine("comanda nu poate rămâne fără linii", r.stare === 200 && r.text.indexOf("fără nicio linie") !== -1, r.stare);
    bine("și nu s-a șters nimic", BAZA.linii.length === cateLinii, BAZA.linii.length);
    bine("nici n-a intrat ceva în istoric", BAZA.istoric.length === nAinte);

    const f = await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular(CA_ACUM, { partener_id: "" }), ADMIN);
    bine("fără client nu se salvează", f.text.indexOf("Alege clientul") !== -1);
  }

  console.log("\nClientul schimbat se scrie cu numele");
  {
    const nAinte = BAZA.istoric.length;
    await cheama("POST", "/comenzi/:id/editare", { id: "5" }, formular([[1, 25000, 0.42]], { partener_id: "4" }), ADMIN);
    const h = BAZA.istoric.slice(nAinte).find((x) => x.ce === "Client");
    bine("schimbarea de client e scrisă", Boolean(h), BAZA.istoric.slice(nAinte).map((x) => x.ce));
    bine("cu numele firmelor, nu cu id-uri",
      h && h.vechi.indexOf("Sameday") !== -1 && h.nou.indexOf("Delivery") !== -1, h);
  }

  console.log("\nIstoricul se vede pe comandă");
  {
    const r = await cheama("GET", "/comenzi/:id", { id: "5" }, {}, ADMIN);
    bine("pagina comenzii se deschide", r.stare === 200, r.stare);
    bine("are secțiunea de istoric", r.text.indexOf("Ce s-a modificat pe comandă") !== -1);
    bine("scrie cine a făcut-o", r.text.indexOf("Owner Client") !== -1);
    bine("și spune că rândurile nu se șterg", r.text.indexOf("nu se șterg") !== -1);
    bine("adminul vede butonul de modificare", r.text.indexOf("/comenzi/5/editare") !== -1);

    const s = await cheama("GET", "/comenzi/:id", { id: "5" }, {}, STRAIN);
    bine("străinul NU vede butonul de modificare", s.text.indexOf("/comenzi/5/editare") === -1);
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("CRAPAT:", e && e.stack ? e.stack : e);
  process.exit(1);
});
