"use strict";
// Adresa de livrare a partenerului, cu bifa „aceeași cu adresa partenerului".
//
// CEREREA LUI VALI, 23.11.2026: „La adăugare partener să fie și adresa de
// livrare, și o bifă că e aceeași dacă e identică cu cea de partener."
//
// CE APĂRĂ:
//   • bifată (starea din start) nu se scrie nimic: adresa de livrare urmează
//     adresa partenerului și când aceasta se schimbă;
//   • debifată, adresa trebuie scrisă — altfel partenerul nu se salvează;
//   • o adresă de livrare scrisă la fel ca a partenerului se ține ca „aceeași";
//   • merge la fel în formularul de partener, la modificare și în „Client nou"
//     scris din comandă; unei firme care există deja nu i se cere;
//   • se vede pe fișa partenerului.
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
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
for (const m of ["parteneri"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98111, nume: "Vali Test", rol: "admin", email: "v.al@test.ro" };
const AGENT = { id: 98112, nume: "Gabriela Test", rol: "vanzari", email: "g.al@test.ro" };

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

const AL = require(path.join(RAD, "lib", "adresa-livrare.js"));
const CN = require(path.join(RAD, "lib", "client-nou.js"));
const NUME = "AL-TEST";
function curata() {
  for (const s of [
    `DELETE FROM interactiuni WHERE partener_id IN (SELECT id FROM parteneri WHERE nume LIKE '${NUME}%')`,
    `DELETE FROM parteneri WHERE nume LIKE '${NUME}%'`,
    "DELETE FROM utilizatori WHERE id BETWEEN 98111 AND 98119",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const part = (nume) => q("SELECT id, adresa, adresa_livrare, localitate, 1 AS x FROM parteneri WHERE nume = ?", [nume])[0] || null;
const corp = (nume, extra) => Object.assign({ tip: "client", nume, cui: "HU" + String(nume.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 99999989, 7)).padStart(8, "0"), reg_com: "", email: "a@altest.ro", telefon: "0722000111", persoana_contact: "Ion", stare: "client_activ", sursa: "", data_nastere: "", adresa: "Str. Lunga 5", localitate: "Craiova", judet: "Dolj", tara: "Romania", termen_plata_zile: "30" }, extra || {});
const text = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

(async () => {
  console.log("── Regula, fără bază ────────────────────────────────────────");
  const f = (b) => AL.dinFormular(b);
  egal("bifată: nu se scrie nimic, orice ar fi rămas în câmp", [f({ livrare_identica: "1", adresa_livrare: "" }), f({ livrare_identica: "1", adresa_livrare: "Depozit vechi 3" })], [{ ok: true, valoare: "" }, { ok: true, valoare: "" }]);
  egal("debifată, cu adresă: se scrie adresa, curățată de rânduri goale și spații", f({ livrare_identica: "0", adresa_livrare: "  Depozit Nord \r\n\r\n  Hala 3  ", adresa: "Str. Lunga 5" }), { ok: true, valoare: "Depozit Nord\nHala 3" });
  egal("debifată, fără adresă: refuzată, cu mesaj", [f({ adresa_livrare: "" }), f({ livrare_identica: "0", adresa_livrare: "   \n " })], [{ ok: false, eroare: AL.MESAJ_LIPSA }, { ok: false, eroare: AL.MESAJ_LIPSA }]);
  egal("scrisă la fel ca adresa partenerului (alte majuscule, diacritice, virgule): se ține ca „aceeași”", [f({ adresa_livrare: "STR. Lungă, 5", adresa: "Str. Lunga 5" }), f({ adresa_livrare: "Str. Lunga 5 bis", adresa: "Str. Lunga 5" }).valoare], [{ ok: true, valoare: "" }, "Str. Lunga 5 bis"]);
  egal("un apel care nu trimite deloc câmpurile (import, formular vechi) lasă „aceeași”; lipsa câmpului nu e o debifare", [f({}), f(null), f({ adresa: "x" })], [{ ok: true, valoare: "" }, { ok: true, valoare: "" }, { ok: true, valoare: "" }]);
  bine("o adresă de peste 400 de semne e refuzată", f({ adresa_livrare: "a".repeat(401) }).ok === false && f({ adresa_livrare: "a".repeat(400) }).ok === true);
  egal("unde se livrează: adresa de livrare, altfel a partenerului (cea întregită, dacă e dată)", [AL.efectiva({ adresa_livrare: "Depozit Nord\nHala 3", adresa: "X" }), AL.efectiva({ adresa_livrare: " ", adresa: "Str. Lunga 5" }), AL.efectiva({ adresa: "Str. Lunga 5" }, "Str. Lunga 5, Craiova, Jud. Dolj"), AL.eIdentica({ adresa_livrare: null }), AL.eIdentica({ adresa_livrare: "x" })], ["Depozit Nord, Hala 3", "Str. Lunga 5", "Str. Lunga 5, Craiova, Jud. Dolj", true, false]);
  let c = AL.campFormular({});
  bine("câmpul din formular: bifa e pusă din start și câmpul de adresă e ascuns", /name="livrare_identica" value="1" checked/.test(c) && /<textarea name="adresa_livrare"[^>]*style="display:none"/.test(c) && c.includes("aceeași cu adresa partenerului"));
  c = AL.campFormular({ adresa_livrare: 'Depozit "Nord" <3>' });
  bine("la un partener cu adresă de livrare: bifa scoasă, adresa la vedere, cu semnele scăpate", !/name="livrare_identica" value="1" checked/.test(c) && !/<textarea name="adresa_livrare"[^>]*display:none/.test(c) && c.includes("Depozit &quot;Nord&quot; &lt;3&gt;"));
  c = AL.campFormular({ adresa_livrare: "", livrare_identica: "0" });
  bine("formularul întors cu „scrie adresa” păstrează bifa scoasă, cum a lăsat-o omul", !/value="1" checked/.test(c) && !/<textarea[^>]*display:none/.test(c));
  const camp = CN.CAMPURI.find((x) => x.nume === "adresa_livrare");
  egal("„Client nou” din comandă are câmpul, cu bifa lui, neobligatoriu ca text", [Boolean(camp), camp && camp.obligatoriu, camp && camp.bifa, camp && camp.numeBifa], [true, false, "aceeași cu adresa firmei", "livrare_identica"]);

  curata();
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98111,'Vali Test','v.al@test.ro','x','y','admin')");

  console.log("\n── Formularul de partener ───────────────────────────────────");
  let r = await cer("/parteneri/nou");
  bine("formularul de partener nou are „Adresa de livrare” cu bifa pusă", r.cod === 200 && r.corp.includes("Adresa de livrare") && /name="livrare_identica" value="1" checked/.test(r.corp) && /<textarea name="adresa_livrare"/.test(r.corp), r.cod);
  r = await cer("/parteneri", { metoda: "post", body: corp(NUME + " Unu SRL", { livrare_identica: "1", adresa_livrare: "" }) });
  egal("bifat „aceeași”: partenerul se salvează, fără adresă de livrare scrisă", [r.cod, part(NUME + " Unu SRL") && part(NUME + " Unu SRL").adresa_livrare], [302, null]);
  r = await cer("/parteneri", { metoda: "post", body: corp(NUME + " Doi SRL", { adresa_livrare: "Depozit Nord, Hala 3, Pitești" }) });
  egal("debifat, cu adresă: se salvează cu adresa de livrare", [r.cod, part(NUME + " Doi SRL") && part(NUME + " Doi SRL").adresa_livrare], [302, "Depozit Nord, Hala 3, Pitești"]);
  r = await cer("/parteneri", { metoda: "post", body: corp(NUME + " Trei SRL", { adresa_livrare: "  " }) });
  bine("debifat, fără adresă: nu se salvează, mesajul o spune, iar formularul rămâne cu bifa scoasă și cu restul datelor", r.cod === 400 && text(r.corp).includes("Scrie adresa de livrare, sau bifează că e aceeași cu adresa partenerului.") && part(NUME + " Trei SRL") === null && !/name="livrare_identica" value="1" checked/.test(r.corp) && r.corp.includes('value="' + NUME + ' Trei SRL"'), r.cod);
  r = await cer("/parteneri", { metoda: "post", body: corp(NUME + " Patru SRL", { adresa_livrare: "str. LUNGA, 5" }) });
  egal("adresa de livrare scrisă la fel ca a partenerului: ținută ca „aceeași”", [r.cod, part(NUME + " Patru SRL").adresa_livrare], [302, null]);
  r = await cer("/parteneri", { metoda: "post", body: corp(NUME + " Cinci SRL", { adresa_livrare: "Depozit Sud", termen_plata_zile: "abc" }) });
  bine("altă greșeală în formular: adresa de livrare scrisă nu se pierde", r.cod === 400 && part(NUME + " Cinci SRL") === null && />Depozit Sud<\/textarea>/.test(r.corp) && !/name="livrare_identica" value="1" checked/.test(r.corp));

  console.log("\n── Modificarea și fișa ──────────────────────────────────────");
  const unu = part(NUME + " Unu SRL"), doi = part(NUME + " Doi SRL");
  r = await cer("/parteneri/:id/editare", { params: { id: String(doi.id) } });
  bine("la modificare, partenerul cu adresă de livrare o arată, cu bifa scoasă", />Depozit Nord, Hala 3, Pitești<\/textarea>/.test(r.corp) && !/name="livrare_identica" value="1" checked/.test(r.corp));
  r = await cer("/parteneri/:id/editare", { params: { id: String(unu.id) } });
  bine("… cel fără o are bifată", /name="livrare_identica" value="1" checked/.test(r.corp));
  r = await cer("/parteneri/:id/editare", { metoda: "post", params: { id: String(doi.id) }, body: corp(NUME + " Doi SRL", { livrare_identica: "1", adresa_livrare: "Depozit Nord, Hala 3, Pitești" }) });
  egal("bifa pusă la loc la modificare: adresa de livrare se golește (urmează adresa partenerului)", [r.cod, part(NUME + " Doi SRL").adresa_livrare], [302, null]);
  r = await cer("/parteneri/:id/editare", { metoda: "post", params: { id: String(unu.id) }, body: corp(NUME + " Unu SRL", { adresa_livrare: "Punct de lucru Bragadiru" }) });
  egal("… și se poate pune una nouă pe un partener existent", part(NUME + " Unu SRL").adresa_livrare, "Punct de lucru Bragadiru");
  r = await cer("/parteneri/:id/editare", { metoda: "post", params: { id: String(unu.id) }, body: corp(NUME + " Unu SRL", { adresa_livrare: "" }) });
  egal("… debifat și gol la modificare: refuzat, adresa veche rămâne", [r.cod, part(NUME + " Unu SRL").adresa_livrare], [400, "Punct de lucru Bragadiru"]);
  r = await cer("/parteneri/:id", { params: { id: String(unu.id) } });
  bine("fișa partenerului arată adresa de livrare", r.cod === 200 && /data-adresa-livrare-fisa>[\s\S]{0,120}Punct de lucru Bragadiru/.test(r.corp), r.cod);
  r = await cer("/parteneri/:id", { params: { id: String(doi.id) } });
  bine("… iar la cel fără, spune „aceeași cu adresa partenerului”", /data-adresa-livrare-fisa>[\s\S]{0,200}aceeași cu adresa partenerului/.test(r.corp));

  console.log("\n── „Client nou”, scris din comandă ──────────────────────────");
  const rapid = async (b) => { const x = await cer("/parteneri/rapid", { metoda: "post", body: b }); return { cod: x.cod, j: JSON.parse(x.corp || "{}") }; };
  const mic = (nume, extra) => Object.assign({ nume, cui: corp(nume).cui, localitate: "Craiova", adresa: "Str. Scurta 2", telefon: "0722", email: "x@altest.ro", persoana_contact: "Ana", termen_plata_zile: "15" }, extra || {});
  let x = await rapid(mic(NUME + " Rapid Unu SRL", { livrare_identica: "1", adresa_livrare: "" }));
  egal("bifat: clientul se scrie, fără adresă de livrare", [x.cod, x.j.reutilizat, part(NUME + " Rapid Unu SRL").adresa_livrare], [200, false, null]);
  x = await rapid(mic(NUME + " Rapid Doi SRL", { livrare_identica: "0", adresa_livrare: "Șantier Calea Severinului 40" }));
  egal("debifat, cu adresă: se scrie cu ea", [x.cod, part(NUME + " Rapid Doi SRL").adresa_livrare], [200, "Șantier Calea Severinului 40"]);
  x = await rapid(mic(NUME + " Rapid Trei SRL", { livrare_identica: "0", adresa_livrare: "" }));
  egal("debifat, fără adresă: clientul nu se scrie, cu mesajul pe ecran", [x.cod, x.j.gresite, part(NUME + " Rapid Trei SRL")], [400, [AL.MESAJ_LIPSA], null]);
  x = await rapid({ nume: NUME + " Rapid Patru SRL", cui: "", livrare_identica: "0", adresa_livrare: "" });
  bine("… împreună cu celelalte lipsuri, toate deodată", x.cod === 400 && x.j.gresite.includes(AL.MESAJ_LIPSA) && x.j.gresite.length > 3, JSON.stringify(x.j.gresite));
  x = await rapid({ nume: NUME + " Rapid Doi SRL", cui: corp(NUME + " Rapid Doi SRL").cui, livrare_identica: "0", adresa_livrare: "" });
  egal("firma există deja: se refolosește fără să i se ceară adresa de livrare, iar cea scrisă rămâne", [x.cod, x.j.reutilizat, part(NUME + " Rapid Doi SRL").adresa_livrare], [200, true, "Șantier Calea Severinului 40"]);
  x = await rapid(mic(NUME + " Rapid Cinci SRL"));
  egal("un apel fără câmpurile de livrare (versiunea veche a paginii, încă deschisă la cineva) merge ca înainte", [x.cod, part(NUME + " Rapid Cinci SRL").adresa_livrare], [200, null]);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
