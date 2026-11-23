"use strict";
// „Livrare la" pe comandă: adresa de livrare a partenerului, persoana de
// contact, telefonul și emailul.
//
// CEREREA LUI VALI, 23.11.2026: „La comandă nouă să poți selecta adresa de
// livrare a partenerului, alături de persoană, nr. de telefon și email."
//
// CE APĂRĂ:
//   • clientul ales își aduce adresa de livrare (sau adresa firmei), persoana
//     de contact, telefonul și emailul; se pot alege și celelalte ale lui;
//   • ce rămâne pe comandă e textul de atunci: fișa schimbată mâine nu mută
//     comanda de ieri;
//   • ce scrie omul peste se păstrează; un câmp șters rămâne gol; un apel care
//     nu trimite câmpurile (pagină veche) ia ce are clientul;
//   • la modificare schimbările intră în istoric, iar ce nu vine rămâne cum era.
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
let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
// SmartBill nu e configurat în test: validarea facturii nu trimite nimic.
for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => ({ ok: true }), trimiteDeLa: async () => ({ ok: true }), configUtilizator: async () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98311, nume: "Vali Test", rol: "admin", email: "v.ll@test.ro" };
const AGENT = { id: 98312, nume: "Gabriela Test", rol: "vanzari", email: "g.ll@test.ro" };

async function cer(cale, { user = ADMIN, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));

const LL = require(path.join(RAD, "lib", "livrare-la.js"));
function curata() {
  for (const s of [
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (98301, 98302))",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (98301, 98302))",
    "DELETE FROM emailuri WHERE partener_id IN (98301, 98302)",
    "DELETE FROM comenzi WHERE partener_id IN (98301, 98302)",
    "DELETE FROM interactiuni WHERE partener_id IN (98301, 98302)",
    "DELETE FROM mk_contacte WHERE partener_id IN (98301, 98302)",
    "DELETE FROM parteneri WHERE id IN (98301, 98302)",
    "DELETE FROM produse WHERE id = 98321",
    "DELETE FROM utilizatori WHERE id BETWEEN 98311 AND 98319",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const comanda = (id) => q("SELECT * FROM comenzi WHERE id = ?", [id])[0];
const livrare = (id) => { const c = comanda(id) || {}; return [c.livrare_adresa, c.livrare_contact, c.livrare_telefon, c.livrare_email]; };
const corp = (partener, extra) => Object.assign({ partener_id: String(partener), numar: "", livrare_partiala: "nu", livrare_mod: "intern", branding: "nepersonalizat", moneda: "RON", termen_plata_zile: "", "produs_id[]": ["98321"], "cantitate[]": ["2"], "pret_unitar[]": ["10"], "um[]": ["buc"] }, extra || {});
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/comenzi\/(\d+)/) || [])[1] || 0);
const json = async (partener, user) => { const r = await cer("/comenzi/livrare-la.json", { query: { partener: String(partener) }, user: user === undefined ? ADMIN : user }); return { cod: r.cod, j: JSON.parse(r.corp || "{}") }; };

(async () => {
  console.log("── Ce are partenerul, fără bază ─────────────────────────────");
  const P = { adresa: "Str. Lungă 5", localitate: "Craiova", judet: "Dolj", adresa_livrare: "Depozit Nord\nHala 3, Pitești", persoana_contact: "Ion Popescu", telefon: "0722 111 222", email: "ion@firma.ro" };
  const C = [{ nume: "Ana Marin", functie: "Achiziții", telefon: "0733 000 111", email: "ana@firma.ro" }, { nume: "ion popescu", functie: "Director", telefon: "", email: "ion2@firma.ro" }, { nume: " ", telefon: "1" }];
  let o = LL.optiuni(P, C);
  egal("adresele: întâi cea de livrare, apoi a firmei (întregită cu localitatea și județul)", o.adrese, [{ text: "Depozit Nord, Hala 3, Pitești", fel: "adresa de livrare" }, { text: "Str. Lungă 5, Craiova, Jud. Dolj", fel: "adresa firmei" }]);
  egal("persoanele: cea de pe fișă, apoi cele de la Contacte; aceeași persoană nu apare de două ori, iar cele fără nume nu apar", o.contacte, [{ nume: "Ion Popescu", telefon: "0722 111 222", email: "ion@firma.ro", fel: "de pe fișa firmei" }, { nume: "Ana Marin", telefon: "0733 000 111", email: "ana@firma.ro", fel: "Achiziții" }]);
  egal("din start: adresa de livrare și persoana de pe fișă, cu telefonul și emailul ei", o.implicit, { livrare_adresa: "Depozit Nord, Hala 3, Pitești", livrare_contact: "Ion Popescu", livrare_telefon: "0722 111 222", livrare_email: "ion@firma.ro" });
  o = LL.optiuni({ adresa: "Str. Lungă 5, Craiova", localitate: "Craiova", judet: "Dolj", telefon: "0722", email: "office@firma.ro" }, []);
  egal("partener cu livrarea „aceeași” și fără persoană pe fișă: adresa firmei (localitatea nu se repetă), telefonul și emailul firmei", [o.adrese, o.contacte, o.implicit], [[{ text: "Str. Lungă 5, Craiova, Jud. Dolj", fel: "adresa firmei (și de livrare)" }], [], { livrare_adresa: "Str. Lungă 5, Craiova, Jud. Dolj", livrare_contact: "", livrare_telefon: "0722", livrare_email: "office@firma.ro" }]);
  o = LL.optiuni({ adresa: "Str. Lunga 5", adresa_livrare: "STR. LUNGĂ, 5" }, null);
  egal("adresa de livrare scrisă la fel ca a firmei nu apare de două ori", o.adrese.length, 1);
  egal("fără partener: nimic, fără să pice", LL.optiuni(null, null), { adrese: [], contacte: [], implicit: { livrare_adresa: "", livrare_contact: "", livrare_telefon: "", livrare_email: "" } });
  const im = { livrare_adresa: "A", livrare_contact: "B", livrare_telefon: "C", livrare_email: "d@e.ro" };
  egal("din formular: ce a scris omul; câmpul șters rămâne gol; câmpul netrimis ia ce are clientul", LL.dinFormular({ livrare_adresa: "  Șantier   Nord ", livrare_contact: "", livrare_telefon: "0744" }, im), { ok: true, valori: { livrare_adresa: "Șantier Nord", livrare_contact: "", livrare_telefon: "0744", livrare_email: "d@e.ro" } });
  egal("fără nimic trimis (pagină veche, comandă făcută de ERP): ale clientului", [LL.dinFormular({}, im).valori, LL.dinFormular(null, null).valori], [im, { livrare_adresa: "", livrare_contact: "", livrare_telefon: "", livrare_email: "" }]);
  egal("email stricat și text prea lung: refuzate cu mesaj", [LL.dinFormular({ livrare_email: "ion la firma" }, im).eroare, /prea lung/.test(LL.dinFormular({ livrare_adresa: "a".repeat(401) }, im).eroare || ""), LL.dinFormular({ livrare_adresa: "a".repeat(400) }, im).ok], ["Emailul de la livrare, „ion la firma”, nu arată a adresă de email.", true, true]);
  egal("pe pagina comenzii apar doar rândurile completate", [LL.randuri({ livrare_adresa: "X", livrare_telefon: "0722" }), LL.randuri({}), LL.text({ livrare_adresa: "X", livrare_contact: "Y" })], [[{ eticheta: "Adresa de livrare", valoare: "X" }, { eticheta: "Telefon", valoare: "0722" }], [], "X · Y"]);
  const b = LL.bloc({ livrare_adresa: 'Depozit "Nord" <3>' }, { completeaza: true });
  bine("blocul din formular: cele patru câmpuri, listele din care se alege, valoarea scăpată", /name="livrare_adresa" value="Depozit &quot;Nord&quot; &lt;3&gt;"[^>]*list="livrare-la-adrese"/.test(b) && /name="livrare_contact"[^>]*list="livrare-la-oameni"/.test(b) && /name="livrare_telefon"/.test(b) && /type="email" name="livrare_email"/.test(b) && /data-completeaza="1"/.test(b) && />Livrare la</.test(b));

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98311,'Vali Test','v.ll@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip, adresa, localitate, judet, adresa_livrare, persoana_contact, telefon, email, termen_plata_zile) VALUES (98301, 'LL-TEST Client SRL', 'RO98301', 'client', 'Str. Lungă 5', 'Craiova', 'Dolj', 'Depozit Nord, Hala 3, Pitești', 'Ion Popescu', '0722 111 222', 'ion@lltest.ro', 30)",
    "INSERT INTO parteneri (id, nume, cui, tip, adresa, telefon) VALUES (98302, 'LL-TEST Fara SRL', 'RO98302', 'client', 'Bd. Mare 1, Arad', '0257')",
    "INSERT INTO mk_contacte (partener_id, nume, functie, telefon, email) VALUES (98301, 'Ana Marin', 'Achiziții', '0733 000 111', 'ana@lltest.ro')",
    "INSERT INTO mk_contacte (partener_id, nume, functie, telefon, email, activ) VALUES (98301, 'Plecat Demult', 'Fost', '0700', 'p@lltest.ro', 0)",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (98321,'LL-1','Produs LL','buc',10,21)",
  ]) exec(s);

  console.log("\n── Ce primește formularul când se alege clientul ────────────");
  let x = await json(98301);
  egal("adresele și persoanele clientului, fără contactele scoase din uz", [x.cod, x.j.adrese.map((a) => a.text), x.j.contacte.map((c) => c.nume), x.j.implicit], [200, ["Depozit Nord, Hala 3, Pitești", "Str. Lungă 5, Craiova, Jud. Dolj"], ["Ion Popescu", "Ana Marin"], { livrare_adresa: "Depozit Nord, Hala 3, Pitești", livrare_contact: "Ion Popescu", livrare_telefon: "0722 111 222", livrare_email: "ion@lltest.ro" }]);
  egal("client inexistent: 404; fără om logat: 403; fără număr: 404", [(await json(999999999)).cod, (await json(98301, null)).cod, (await json("abc")).cod], [404, 403, 404]);
  let r = await cer("/comenzi/nou");
  bine("formularul de comandă nouă are blocul „Livrare la”, cu completarea la alegerea clientului", r.cod === 200 && /data-livrare-la data-completeaza="1"/.test(r.corp) && r.corp.includes('name="livrare_adresa"') && r.corp.includes("/comenzi/livrare-la.json?partener="), r.cod);

  console.log("\n── Comanda nouă ─────────────────────────────────────────────");
  r = await cer("/comenzi", { metoda: "post", body: corp(98301, { livrare_adresa: "Depozit Nord, Hala 3, Pitești", livrare_contact: "Ion Popescu", livrare_telefon: "0722 111 222", livrare_email: "ion@lltest.ro" }) });
  const c1 = idDinLocatie(r);
  egal("lăsate cum au venit completate: pe comandă rămân ale clientului", [c1 > 0, livrare(c1)], [true, ["Depozit Nord, Hala 3, Pitești", "Ion Popescu", "0722 111 222", "ion@lltest.ro"]]);
  r = await cer("/comenzi", { metoda: "post", body: corp(98301, { livrare_adresa: "Str. Lungă 5, Craiova, Jud. Dolj", livrare_contact: "Ana Marin", livrare_telefon: "0733 000 111", livrare_email: "" }) });
  const c2 = idDinLocatie(r);
  egal("aleasă cealaltă adresă și altă persoană, emailul șters: se scrie exact asta", livrare(c2), ["Str. Lungă 5, Craiova, Jud. Dolj", "Ana Marin", "0733 000 111", null]);
  r = await cer("/comenzi", { metoda: "post", body: corp(98301, { livrare_adresa: "Șantier Calea Severinului 40", livrare_contact: "Maistrul Gigi", livrare_telefon: "0799", livrare_email: "gigi@santier.ro" }) });
  const c3 = idDinLocatie(r);
  egal("scrisă de mână, pentru o livrare în alt loc: se păstrează", livrare(c3), ["Șantier Calea Severinului 40", "Maistrul Gigi", "0799", "gigi@santier.ro"]);
  r = await cer("/comenzi", { metoda: "post", body: corp(98301) });
  const c4 = idDinLocatie(r);
  egal("formular care nu trimite câmpurile (pagină veche, încă deschisă): comanda ia ce are clientul", livrare(c4), ["Depozit Nord, Hala 3, Pitești", "Ion Popescu", "0722 111 222", "ion@lltest.ro"]);
  r = await cer("/comenzi", { metoda: "post", body: corp(98302) });
  const c5 = idDinLocatie(r);
  egal("client fără adresă de livrare și fără persoană: adresa firmei și telefonul ei", livrare(c5), ["Bd. Mare 1, Arad", null, "0257", null]);
  const inainte = Number(q("SELECT COUNT(*) AS n, 1 AS x FROM comenzi WHERE partener_id = 98301")[0].n);
  r = await cer("/comenzi", { metoda: "post", body: corp(98301, { livrare_adresa: "X", livrare_contact: "Y", livrare_telefon: "1", livrare_email: "nu-e-email" }) });
  bine("email stricat: comanda nu se scrie, mesajul o spune, iar ce a scris omul rămâne în formular", r.cod === 200 && r.corp.includes("nu arată a adresă de email") && Number(q("SELECT COUNT(*) AS n, 1 AS x FROM comenzi WHERE partener_id = 98301")[0].n) === inainte && r.corp.includes('name="livrare_email" value="nu-e-email"') && r.corp.includes('name="livrare_adresa" value="X"'), r.cod);

  console.log("\n── Pagina comenzii și fișa schimbată după ───────────────────");
  exec("UPDATE parteneri SET adresa_livrare = 'Alt depozit, Ploiești', persoana_contact = 'Altcineva', telefon = '0000', email = 'alt@lltest.ro' WHERE id = 98301");
  r = await cer("/comenzi/:id", { params: { id: String(c1) } });
  const cutie = (h) => String(h).split("data-livrare-la-comanda")[1] || "";
  const txt = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("pagina comenzii arată „Livrare la” cu ce era la plasare, nu cu fișa de acum", r.cod === 200 && txt(cutie(r.corp)).includes("Adresa de livrare: Depozit Nord, Hala 3, Pitești") && txt(cutie(r.corp)).includes("Persoană de contact: Ion Popescu") && txt(cutie(r.corp)).includes("Telefon: 0722 111 222") && txt(cutie(r.corp)).includes("Email: ion@lltest.ro") && !cutie(r.corp).slice(0, 900).includes("Ploiești"), txt(cutie(r.corp)).slice(0, 300));
  exec(`UPDATE comenzi SET livrare_adresa = NULL, livrare_contact = NULL, livrare_telefon = NULL, livrare_email = NULL WHERE id = ${c4}`);
  r = await cer("/comenzi/:id", { params: { id: String(c4) } });
  bine("o comandă de dinainte, fără „Livrare la”: spune „nescris” și trimite la modificare", txt(cutie(r.corp)).slice(0, 80).includes("nescris") && cutie(r.corp).slice(0, 400).includes(`/comenzi/${c4}/editare`));

  console.log("\n── Modificarea ──────────────────────────────────────────────");
  r = await cer("/comenzi/:id/editare", { params: { id: String(c1) } });
  bine("formularul de modificare vine cu ce e pe comandă și nu le rescrie singur", /data-livrare-la data-completeaza="0"/.test(r.corp) && r.corp.includes('name="livrare_adresa" value="Depozit Nord, Hala 3, Pitești"') && r.corp.includes('name="livrare_contact" value="Ion Popescu"'), r.cod);
  const mod = (partener, extra) => Object.assign(corp(partener, extra), { "pret_exact[]": ["10"], motiv: "test" });
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod(98301, { livrare_adresa: "Punct de lucru Bragadiru", livrare_contact: "Ion Popescu", livrare_telefon: "0722 111 222", livrare_email: "" }) });
  egal("adresa schimbată și emailul șters la modificare: se scriu", livrare(c1), ["Punct de lucru Bragadiru", "Ion Popescu", "0722 111 222", null]);
  egal("… și intră în istoricul comenzii, pe nume", q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? AND ce LIKE 'Livrare:%' ORDER BY ce", [c1]).map((y) => [y.ce, y.vechi, y.nou]), [["Livrare: adresa de livrare", "Depozit Nord, Hala 3, Pitești", "Punct de lucru Bragadiru"], ["Livrare: email", "ion@lltest.ro", null]]);
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c3) }, body: mod(98301, { "cantitate[]": ["3"] }) });
  egal("o modificare care nu trimite câmpurile de livrare le lasă cum erau (nu le ia din fișă)", [livrare(c3), q("SELECT COUNT(*) AS n, 1 AS x FROM comenzi_istoric WHERE comanda_id = ? AND ce LIKE 'Livrare:%'", [c3])[0].n], [["Șantier Calea Severinului 40", "Maistrul Gigi", "0799", "gigi@santier.ro"], "0"]);
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod(98301, { livrare_adresa: "A", livrare_contact: "B", livrare_telefon: "C", livrare_email: "stricat" }) });
  bine("email stricat la modificare: nu se salvează nimic", r.cod === 200 && r.corp.includes("nu arată a adresă de email") && livrare(c2)[0] === "Str. Lungă 5, Craiova, Jud. Dolj");

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
