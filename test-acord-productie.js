"use strict";
// Comanda preluată în producție se modifică doar cu acordul producției.
// PostgreSQL real (baza de test de pe 5433), prin rutele adevărate.
//
// CE A CERUT VALI, 19.11.2026: „Odată preluată în producție, comanda se mai
// poate modifica doar după acordul producției." · „Și să apară cumva în top,
// de revalidat." · „Păstrează istoric modificări per comandă: cine a
// solicitat, cine a validat, data, ora."
//
// CE APĂRĂ:
//   • NEPRELUATĂ (producția e doar „nouă", sau nu există): se modifică liber.
//   • PRELUATĂ: salvarea agentului NU schimbă comanda; lasă o cerere, cu ce
//     s-ar schimba. O a doua cerere, cât prima așteaptă, e refuzată.
//   • DE REVALIDAT: cererea apare sus pe pagina Producției și pe pagina
//     comenzii, cu cine a cerut-o și când, și cu butoanele producției.
//   • DOAR PRODUCȚIA aprobă sau respinge; respingerea cere motiv.
//   • APROBAREA aplică modificarea, pe numele celui care a cerut-o, și scrie
//     în istoricul comenzii cine a cerut și cine a aprobat, cu data și ora.
//   • RESPINGEREA și RETRAGEREA lasă comanda cum era.
//   • CINE ARE PRODUCȚIA modifică direct, și se scrie.
//   • ISTORICUL cererilor rămâne pe comandă: cerută de, validată de, când.
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
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
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});



const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "comenzi.js")).register(router);
require(path.join(RAD, "modules", "productie.js")).register(router);
const ACP = require(path.join(RAD, "lib", "acord-productie.js"));

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  let h = rute[metoda][cale];
  let par = {};
  if (!h) {
    for (const [tipar, fn] of Object.entries(rute[metoda])) {
      const re = new RegExp("^" + tipar.replace(/:[^/]+/g, "([^/]+)") + "$");
      const m = re.exec(cale);
      if (m) {
        const nume = (tipar.match(/:[^/]+/g) || []).map((x) => x.slice(1));
        par = Object.fromEntries(nume.map((n, i) => [n, m[i + 1]]));
        h = fn;
        break;
      }
    }
  }
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  const r = res();
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: {} } });
  return r;
}
const unde = (r) => String((r.antet && r.antet.Location) || "");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const PART = 97901, P1 = 97911, P2 = 97912;
const [K1, K2, K3] = [979001, 979002, 979003];
const VALI = { id: 97921, nume: "Vali Acord", rol: "admin" };
const AGENT = { id: 97922, nume: "Agent Acord", rol: "vanzari" };
const PROD = { id: 97923, nume: "Productie Acord", rol: "productie" };
const DEPOZIT = { id: 97924, nume: "Depozit Acord", rol: "depozit" };
function curata() {
  for (const s of [
    `DELETE FROM comenzi_cereri_modificare WHERE comanda_id IN (${K1}, ${K2}, ${K3})`,
    `DELETE FROM comenzi_istoric WHERE comanda_id IN (${K1}, ${K2}, ${K3})`,
    `DELETE FROM comenzi_productie WHERE comanda_id IN (${K1}, ${K2}, ${K3})`,
    `DELETE FROM comenzi_linii WHERE comanda_id IN (${K1}, ${K2}, ${K3})`,
    `DELETE FROM interactiuni WHERE partener_id = ${PART}`,
    `DELETE FROM comenzi WHERE id IN (${K1}, ${K2}, ${K3})`,
    `DELETE FROM parteneri WHERE id = ${PART}`,
    `DELETE FROM produse WHERE id IN (${P1}, ${P2})`,
    "DELETE FROM utilizatori WHERE id BETWEEN 97921 AND 97929",
  ]) q(s);
}
const formular = (linii, extra) => Object.assign({
  partener_id: String(PART), numar: "ACP-1", data_livrare_ceruta: "2099-12-01",
  livrare_partiala: "da", livrare_mod: "intern", branding: "nepersonalizat", moneda: "RON", observatii: "",
  "produs_id[]": linii.map((l) => String(l[0])),
  "cantitate[]": linii.map((l) => String(l[1])),
  "pret_unitar[]": linii.map((l) => String(l[2])),
  "um[]": linii.map(() => "buc"),
}, extra || {});
const liniiDe = (id) => q(`SELECT produs_id, cantitate, pret_unitar FROM comenzi_linii WHERE comanda_id = ${id} ORDER BY produs_id`).map((x) => [Number(x.produs_id), Number(x.cantitate), Number(x.pret_unitar)]);
const cereriDe = (id) => q(`SELECT id, stare, solicitat_de_nume, validat_de_nume, raspuns, solicitat_la, validat_la FROM comenzi_cereri_modificare WHERE comanda_id = ${id} ORDER BY id`);
const istoricDe = (id) => q(`SELECT utilizator_nume, ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ${id} ORDER BY id`);
const CA_ACUM = [[P1, 1000, 0.5]];
const DATA_ORA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

(async () => {
  curata();
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97921,'Vali Acord','v.acp@test.ro','x','y','admin'), (97922,'Agent Acord','a.acp@test.ro','x','y','vanzari'), (97923,'Productie Acord','p.acp@test.ro','x','y','productie'), (97924,'Depozit Acord','d.acp@test.ro','x','y','depozit')`);
  q(`INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES (${PART}, 'ACP Client SRL', 'RO97901', 'client', 97922)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva, activ) VALUES (${P1}, 'ACP-1', 'ACP Punga', 'buc', 0.5, 21, 1), (${P2}, 'ACP-2', 'ACP Folie', 'buc', 12, 21, 1)`);
  for (const [id, nr] of [[K1, "ACP-1"], [K2, "ACP-2"], [K3, "ACP-3"]]) {
    q(`INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, livrare_partiala, livrare_mod, branding, data_livrare_ceruta) VALUES (${id}, ${PART}, '${nr}', '2099-11-19', 'in_productie', 97922, 97922, 'RON', 'da', 'intern', 'nepersonalizat', '2099-12-01')`);
    q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (${id}, ${P1}, 1000, 0.5, 'buc')`);
  }
  q(`INSERT INTO comenzi_productie (comanda_id, numar, status) VALUES (${K1}, 'ACP-PR-1', 'in_productie'), (${K2}, 'ACP-PR-2', 'noua')`);

  console.log("1. Cine are cuvântul producției și ce înseamnă „preluată”");
  egal("administratorul și producția da; agentul și depozitul nu", [ACP.eProductie(VALI), ACP.eProductie(PROD), ACP.eProductie(AGENT), ACP.eProductie(DEPOZIT), ACP.eProductie(null)], [true, true, false, false, false]);
  egal("bifa „Producție” pusă pe nume dă și ea cuvântul; alte bife nu", [ACP.eProductie({ rol: "vanzari", sectiuni: "/crm,/productie" }), ACP.eProductie({ rol: "vanzari", sectiuni: "/crm,/productie/etichete" })], [true, false]);
  egal("preluată = producția a trecut de „nouă”", [(await ACP.preluataInProductie(K1)).length, (await ACP.preluataInProductie(K2)).length, (await ACP.preluataInProductie(K3)).length], [1, 0, 0]);

  console.log("\n2. Nepreluată: se modifică liber, ca până acum");
  let r = await cer("post", `/comenzi/${K2}/editare`, AGENT, { body: formular([[P1, 1200, 0.5]], { numar: "ACP-2" }) });
  egal("producția e doar „nouă”: salvarea se aplică pe loc", [/ok=modificat/.test(unde(r)), liniiDe(K2), cereriDe(K2).length], [true, [[P1, 1200, 0.5]], 0]);
  r = await cer("post", `/comenzi/${K3}/editare`, AGENT, { body: formular([[P1, 900, 0.5]], { numar: "ACP-3" }) });
  egal("fără comandă de producție: la fel", [/ok=modificat/.test(unde(r)), liniiDe(K3)], [true, [[P1, 900, 0.5]]]);

  console.log("\n3. Preluată: agentul lasă o cerere, comanda rămâne cum era");
  r = await cer("get", `/comenzi/${K1}/editare`, AGENT);
  bine("formularul îi spune dinainte că modificarea pleacă la producție", r.corp.includes("data-acord-necesar") && r.corp.includes("nu se aplică pe loc"));
  r = await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular([[P1, 1500, 0.5], [P2, 10, 12]], { motiv: "clientul a mărit comanda" }) });
  let z = cereriDe(K1);
  egal("salvarea nu schimbă nimic și spune de ce", [/ok=asteapta_productia/.test(unde(r)), liniiDe(K1), istoricDe(K1).length], [true, [[P1, 1000, 0.5]], 0]);
  egal("cererea e scrisă: cine a cerut, în așteptare, cu data și ora", [z.length, z[0].stare, z[0].solicitat_de_nume, DATA_ORA.test(z[0].solicitat_la), z[0].validat_de_nume], [1, "asteapta", "Agent Acord", true, null]);
  const S = ACP.schimbarile(await ACP.citeste(z[0].id));
  bine("…cu ce s-ar schimba: cantitatea și produsul adăugat", S.some((x) => /ACP Punga/.test(x.ce) && /1\.?000/.test(String(x.vechi)) && /1\.?500/.test(String(x.nou))) && S.some((x) => /ACP Folie/.test(x.ce + " " + x.nou)), JSON.stringify(S));
  r = await cer("get", `/comenzi/${K1}`, AGENT, { query: { ok: "asteapta_productia", n: "2" } });
  bine("pagina comenzii: sus, „de revalidat de producție”, cu cine a cerut-o; agentul n-are butoane, dar o poate retrage",
    r.corp.includes("data-asteapta-productia") && r.corp.includes("Agent Acord") && !r.corp.includes(`data-aproba="${z[0].id}"`) && r.corp.includes(`/comenzi/modificari/${z[0].id}/retrage`) && r.corp.includes("NU s-a aplicat încă"));
  r = await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular([[P1, 1600, 0.5]]) });
  egal("a doua cerere, cât prima așteaptă: refuzată", [cereriDe(K1).length, /deja o modificare care așteaptă acordul producției/.test(r.corp), liniiDe(K1)], [1, true, [[P1, 1000, 0.5]]]);

  console.log("\n4. De revalidat, sus, la producție");
  r = await cer("get", "/productie", PROD);
  bine("pagina Producției o arată sus, cu comanda, clientul, cine a cerut și butoanele",
    r.corp.includes("data-de-revalidat") && r.corp.includes("De revalidat: 1 modificare cerută") && r.corp.includes("ACP-1") && r.corp.includes("ACP Client SRL") && r.corp.includes("Agent Acord") && r.corp.includes(`data-aproba="${z[0].id}"`) && r.corp.includes(`data-respinge="${z[0].id}"`) && r.corp.includes("clientul a mărit comanda"));
  bine("…înaintea restului paginii", r.corp.indexOf("data-de-revalidat") > 0 && r.corp.indexOf("data-de-revalidat") < r.corp.indexOf("<table"));
  r = await cer("post", `/comenzi/modificari/${z[0].id}/aproba`, AGENT, { body: { inapoi: "comanda" } });
  egal("agentul nu-și poate aproba singur cererea", [cereriDe(K1)[0].stare, liniiDe(K1), /cineva de la producție/.test(decodeURIComponent(unde(r)))], ["asteapta", [[P1, 1000, 0.5]], true]);
  r = await cer("post", `/comenzi/modificari/${z[0].id}/respinge`, PROD, { body: { inapoi: "productie", raspuns: "" } });
  egal("respingerea fără motiv nu trece", [cereriDe(K1)[0].stare, /Scrie de ce respingi/.test(decodeURIComponent(unde(r)))], ["asteapta", true]);

  console.log("\n5. Aprobarea aplică modificarea și scrie cine a cerut și cine a aprobat");
  r = await cer("post", `/comenzi/modificari/${z[0].id}/aproba`, PROD, { body: { inapoi: "productie" } });
  z = cereriDe(K1);
  egal("comanda e schimbată acum", [liniiDe(K1), unde(r).startsWith("/productie?ok_acord=")], [[[P1, 1500, 0.5], [P2, 10, 12]], true]);
  egal("cererea: aprobată, de cine, cu data și ora", [z[0].stare, z[0].validat_de_nume, DATA_ORA.test(z[0].validat_la)], ["aprobata", "Productie Acord", true]);
  let ist = istoricDe(K1);
  bine("istoricul comenzii: schimbările sunt pe numele celui care a cerut", ist.length >= 3 && ist.every((x) => x.utilizator_nume === "Agent Acord"), JSON.stringify(ist));
  const acord = ist.find((x) => x.ce === "Acordul producției");
  bine("…cu rândul acordului: cerută de cine și când, aprobată de cine și când", acord && /cerută de Agent Acord la \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(acord.vechi) && /aprobată de Productie Acord la \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(acord.nou), JSON.stringify(acord));
  bine("…și motivul celui care a cerut", ist.some((x) => x.ce === "Motivul modificării" && x.nou === "clientul a mărit comanda"));
  r = await cer("post", `/comenzi/modificari/${z[0].id}/aproba`, PROD, { body: { inapoi: "productie" } });
  egal("o cerere închisă nu se aplică a doua oară", [liniiDe(K1), /deja aprobată/.test(decodeURIComponent(unde(r)))], [[[P1, 1500, 0.5], [P2, 10, 12]], true]);
  r = await cer("get", "/productie", PROD);
  bine("nu mai e nimic de revalidat", !r.corp.includes("data-de-revalidat"));

  console.log("\n6. Respinsă și retrasă: comanda rămâne cum era");
  await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular([[P1, 9000, 0.5], [P2, 10, 12]]) });
  let id2 = cereriDe(K1)[1].id;
  r = await cer("post", `/comenzi/modificari/${id2}/respinge`, PROD, { body: { inapoi: "comanda", raspuns: "folia e deja tăiată" } });
  z = cereriDe(K1);
  egal("respinsă cu motiv: comanda neschimbată, cu cine a respins și când", [z[1].stare, z[1].validat_de_nume, z[1].raspuns, DATA_ORA.test(z[1].validat_la), liniiDe(K1)], ["respinsa", "Productie Acord", "folia e deja tăiată", true, [[P1, 1500, 0.5], [P2, 10, 12]]]);
  bine("…și rămâne scris în istoricul comenzii", istoricDe(K1).some((x) => x.ce === "Acordul producției" && /respinsă: folia e deja tăiată/.test(x.nou) && x.utilizator_nume === "Productie Acord"));
  await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular([[P1, 7000, 0.5], [P2, 10, 12]]) });
  const id3 = cereriDe(K1)[2].id;
  r = await cer("post", `/comenzi/modificari/${id3}/retrage`, DEPOZIT, { body: { inapoi: "comanda" } });
  egal("altcineva nu o poate retrage", cereriDe(K1)[2].stare, "asteapta");
  r = await cer("post", `/comenzi/modificari/${id3}/retrage`, AGENT, { body: { inapoi: "comanda" } });
  egal("cel care a cerut-o o retrage", [cereriDe(K1)[2].stare, liniiDe(K1)], ["retrasa", [[P1, 1500, 0.5], [P2, 10, 12]]]);

  console.log("\n7. Cine are Producția modifică direct");
  r = await cer("get", `/comenzi/${K1}/editare`, VALI);
  bine("formularul îi spune că se aplică direct", r.corp.includes("data-acord-direct") && !r.corp.includes("data-acord-necesar"));
  r = await cer("post", `/comenzi/${K1}/editare`, VALI, { body: formular([[P1, 2000, 0.5], [P2, 10, 12]]) });
  egal("administratorul: aplicat pe loc, fără cerere", [/ok=modificat/.test(unde(r)), liniiDe(K1), cereriDe(K1).length], [true, [[P1, 2000, 0.5], [P2, 10, 12]], 3]);
  bine("…și scris ca modificare făcută direct pe o comandă preluată", istoricDe(K1).some((x) => x.ce === "Acordul producției" && /modificată direct de Vali Acord/.test(x.nou)));

  console.log("\n8. Modificarea care nu mai trece la aprobare rămâne în așteptare");
  await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular([[P1, 2500, 0.5], [P2, 10, 12]]) });
  const id4 = cereriDe(K1)[3].id;
  q(`UPDATE comenzi_cereri_modificare SET corp = REPLACE(corp, '"livrare_partiala":"da"', '"livrare_partiala":""') WHERE id = ${id4}`);
  r = await cer("post", `/comenzi/modificari/${id4}/aproba`, PROD, { body: { inapoi: "productie" } });
  egal("nu se aplică pe jumătate: comanda neschimbată, cererea tot în așteptare, cu motivul spus", [liniiDe(K1), cereriDe(K1)[3].stare, /nu s-a putut aplica/.test(decodeURIComponent(unde(r))) && /livrare parțială/i.test(decodeURIComponent(unde(r)))], [[[P1, 2000, 0.5], [P2, 10, 12]], "asteapta", true]);

  console.log("\n9. Istoricul cererilor, pe pagina comenzii");
  r = await cer("get", `/comenzi/${K1}`, VALI);
  bine("toate cererile, cu cine a cerut, starea, cine a validat și când",
    r.corp.includes("data-istoric-acord") && r.corp.includes("Modificări cerute cu acordul producției") && r.corp.includes(">aprobată<") && r.corp.includes(">respinsă<") && r.corp.includes(">retrasă<") && r.corp.includes("așteaptă producția") && r.corp.includes("folia e deja tăiată") && r.corp.includes("Productie Acord"));
  bine("…iar administratorul are butoanele pe cea care așteaptă", r.corp.includes(`data-aproba="${id4}"`));
  r = await cer("get", `/comenzi/${K2}`, AGENT);
  bine("o comandă nepreluată n-are nimic din toate astea", !r.corp.includes("data-asteapta-productia") && !r.corp.includes("data-istoric-acord") && !r.corp.includes("data-preluata-in-productie"));

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESECURI" : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("ESEC (crash):", e.stack || e.message);
  try { curata(); } catch (x) { /* best-effort */ }
  process.exit(1);
});
