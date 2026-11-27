"use strict";
// Statusul pe produs, într-o comandă cu mai multe produse.
// PostgreSQL real (baza de test de pe 5433), prin rutele adevărate.
//
// CEREREA LUI VALI, 27.11.2026: „Dacă sunt mai multe produse în comandă, să se
// poată schimba statusul ca livrat etc. și doar la unul sau mai multe produse,
// nu doar la toată comanda."
//
// CE APĂRĂ:
//   • produsele bifate primesc starea aleasă; celelalte și comanda rămân;
//   • când TOATE produsele au aceeași stare, trece și comanda pe ea;
//   • când comanda e mutată mai departe și ajunge produsul din urmă, produsul
//     merge din nou cu ea; cel aflat înaintea ei își păstrează starea;
//   • drepturile sunt cele de la statusul comenzii (agentul nu pune „livrată");
//   • nu se mișcă stoc, nu se atinge cantitatea livrată, nu se face factură;
//   • fiecare schimbare intră în istoricul comenzii; lista de comenzi spune
//     câte produse au altă stare.
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

const SL = require(path.join(RAD, "lib", "status-linii.js"));
const PART = 98801, P1 = 98811, P2 = 98812, P3 = 98813;
const [K1, K2, K3] = [988001, 988002, 988003];
const VALI = { id: 98821, nume: "Vali Sl", rol: "admin" };
const AGENT = { id: 98822, nume: "Agent Sl", rol: "vanzari" };
const DEPOZIT = { id: 98823, nume: "Depozit Sl", rol: "depozit" };
const TOATE = `${K1}, ${K2}, ${K3}`;
function curata() {
  for (const s of [
    `DELETE FROM comenzi_istoric WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM comenzi_linii WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM interactiuni WHERE partener_id = ${PART}`,
    `DELETE FROM facturi WHERE partener_id = ${PART}`,
    `DELETE FROM comenzi WHERE id IN (${TOATE})`,
    `DELETE FROM parteneri WHERE id = ${PART}`,
    `DELETE FROM produse WHERE id IN (${P1}, ${P2}, ${P3})`,
    "DELETE FROM utilizatori WHERE id BETWEEN 98821 AND 98829",
  ]) q(s);
}
const idLinie = (k, p) => Number(q(`SELECT id FROM comenzi_linii WHERE comanda_id = ${k} AND produs_id = ${p}`)[0].id);
const stare = (k) => ({ comanda: q(`SELECT status FROM comenzi WHERE id = ${k}`)[0].status, linii: q(`SELECT produs_id, status_linie FROM comenzi_linii WHERE comanda_id = ${k} ORDER BY produs_id`).map((x) => x.status_linie) });
const livrat = (k) => q(`SELECT cantitate_livrata FROM comenzi_linii WHERE comanda_id = ${k} ORDER BY produs_id`).map((x) => Number(x.cantitate_livrata));
const istoric = (k) => q(`SELECT utilizator_nume, ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ${k} ORDER BY id`).map((x) => [x.utilizator_nume, x.ce, x.vechi, x.nou]);
const mesaj = (r, cheie) => decodeURIComponent((unde(r).match(new RegExp("[?&]" + cheie + "=([^&#]*)")) || [])[1] || "");
const schimba = (k, user, linii, status) => cer("post", `/comenzi/${k}/status-linii`, user, { body: { linie: linii.map(String), status } });
const celula = (corp, id) => (String(corp).split(`data-status-linie="${id}"`)[1] || "").split("</td>")[0].replace(/^[^>]*>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  console.log("1. Regula, fără bază");
  const C = { status: "gata_livrare" };
  egal("fără stare pe produs: are statusul comenzii", SL.efectiv({}, C), "gata_livrare");
  egal("stare pusă cât comanda era aici: e a produsului, fie înainte, fie în urmă", [SL.efectiv({ status_linie: "livrata", status_linie_comanda: "gata_livrare" }, C), SL.efectiv({ status_linie: "in_productie", status_linie_comanda: "gata_livrare" }, C)], ["livrata", "in_productie"]);
  egal("comanda a fost mutată între timp: produsul rămas în urmă merge cu ea, cel aflat înainte își păstrează starea", [SL.efectiv({ status_linie: "in_productie", status_linie_comanda: "confirmata" }, C), SL.efectiv({ status_linie: "livrata", status_linie_comanda: "confirmata" }, C)], ["gata_livrare", "livrata"]);
  egal("comanda anulată: toate produsele sunt anulate; un produs anulat rămâne anulat cât comanda merge", [SL.efectiv({ status_linie: "livrata", status_linie_comanda: "gata_livrare" }, { status: "anulata" }), SL.efectiv({ status_linie: "anulata", status_linie_comanda: "confirmata" }, C)], ["anulata", "anulata"]);
  const L3 = [{ id: 1 }, { id: 2, status_linie: "livrata", status_linie_comanda: "gata_livrare" }, { id: 3, status_linie: "livrata", status_linie_comanda: "gata_livrare" }];
  egal("rezumatul pentru listă", [SL.rezumat(L3, C), SL.rezumat([{ id: 1 }, { id: 2 }], C), SL.rezumat([{ id: 1, status_linie: "livrata", status_linie_comanda: "gata_livrare" }, { id: 2, status_linie: "in_livrare", status_linie_comanda: "gata_livrare" }, { id: 3 }], C)], ["2 din 3 produse: 2 livrată", "", "2 din 3 produse: 1 livrată, 1 în livrare"]);
  const PERM = ["confirmata", "gata_livrare", "in_livrare", "livrata", "anulata"];
  let h = SL.hotaraste({ comanda: C, linii: L3, ids: [1], status: "livrata", permise: PERM });
  egal("ultimul produs trecut pe aceeași stare: trece și comanda", [h.ok, h.comandaPe, h.schimbari.length], [true, "livrata", 1]);
  h = SL.hotaraste({ comanda: C, linii: L3, ids: [2], status: SL.RESET, permise: PERM });
  egal("„la fel ca toată comanda”: produsul își pierde starea proprie", [h.deScris, h.schimbari.map((x) => [x.vechi, x.nou]), h.comandaPe], [[{ id: 2, status_linie: null, status_linie_comanda: null }], [["livrata", "gata_livrare"]], null]);
  egal("refuzuri: nimic bifat, stare care nu e a omului, comandă anulată, om fără pași", [SL.hotaraste({ comanda: C, linii: L3, ids: [], status: "livrata", permise: PERM }).eroare, SL.hotaraste({ comanda: C, linii: L3, ids: [1], status: "facturata", permise: PERM }).eroare, SL.hotaraste({ comanda: { status: "anulata" }, linii: L3, ids: [1], status: "livrata", permise: PERM }).eroare, SL.hotaraste({ comanda: C, linii: L3, ids: [1], status: "livrata", permise: [] }).eroare].map((x) => /Bifează|nu e una dintre|anulată|n-ai pași/.exec(x)[0]), ["Bifează", "nu e una dintre", "anulată", "n-ai pași"]);
  egal("un id de linie din altă comandă nu se ia în seamă", SL.hotaraste({ comanda: C, linii: L3, ids: [999], status: "livrata", permise: PERM }).ok, false);

  curata();
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98821,'Vali Sl','v.sl@test.ro','x','y','admin'), (98822,'Agent Sl','a.sl@test.ro','x','y','vanzari'), (98823,'Depozit Sl','d.sl@test.ro','x','y','depozit')`);
  q(`INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES (${PART}, 'SL Client SRL', 'RO98801', 'client', 98822)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva, activ) VALUES (${P1}, 'SL-1', 'SL Punga', 'buc', 1, 21, 1), (${P2}, 'SL-2', 'SL Folie', 'buc', 2, 21, 1), (${P3}, 'SL-3', 'SL Banda', 'buc', 3, 21, 1)`);
  for (const [id, n, st, prod] of [[K1, "SL-1", "gata_livrare", [P1, P2, P3]], [K2, "SL-2", "gata_livrare", [P1]], [K3, "SL-3", "in_productie", [P1, P2]]]) {
    q(`INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, livrare_partiala, livrare_mod, branding, data_livrare_ceruta) VALUES (${id}, ${PART}, '${n}', to_char(now(), 'YYYY-MM-DD'), '${st}', 98822, 98822, 'RON', 'da', 'intern', 'nepersonalizat', '2099-12-01')`);
    for (const p of prod) q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (${id}, ${p}, 100, 1, 'buc')`);
  }
  const [a1, a2, a3] = [idLinie(K1, P1), idLinie(K1, P2), idLinie(K1, P3)];

  console.log("\n2. Pagina comenzii");
  let r = await cer("get", `/comenzi/${K1}`, DEPOZIT);
  bine("comandă cu trei produse: coloana „Status”, o bifă pe fiecare produs și formularul pentru cele bifate", r.cod === 200 && r.corp.includes("data-status-linii") && [a1, a2, a3].every((id) => r.corp.includes(`name="linie" value="${id}" form="status-linii"`)) && r.corp.includes("Schimbă statusul la produsele bifate") && celula(r.corp, a1) === "gata de livrare");
  bine("în listă sunt doar stările depozitului, plus „la fel ca toată comanda”", /<form id="status-linii"[\s\S]*<option value="livrata">livrată<\/option>[\s\S]*<option value="ca_comanda">/.test(r.corp) && !/<form id="status-linii"[\s\S]*<option value="facturata"/.test(r.corp.split("</form>").find((x) => x.includes('id="status-linii"')) || ""));
  r = await cer("get", `/comenzi/${K2}`, DEPOZIT);
  bine("comandă cu un singur produs: nimic în plus, statusul e al comenzii", r.cod === 200 && !r.corp.includes("data-status-linii") && !r.corp.includes("data-status-linie="));
  r = await cer("get", `/comenzi/${K1}`, AGENT);
  bine("agentul vede statusul fiecărui produs; bifele le are doar pentru ce poate pune el (anulată)", r.corp.includes(`data-status-linie="${a1}"`) && /<form id="status-linii"/.test(r.corp) && !/<form id="status-linii"[\s\S]*?<option value="livrata"/.test((r.corp.split('<form id="status-linii"')[1] || "").split("</form>")[0]));

  console.log("\n3. Un produs din trei, livrat");
  r = await schimba(K1, DEPOZIT, [a1], "livrata");
  egal("produsul bifat e „livrată”; celelalte două și comanda rămân „gata de livrare”", [/1 produs trecut pe „livrată”/.test(mesaj(r, "status_linii_ok")), stare(K1)], [true, { comanda: "gata_livrare", linii: ["livrata", null, null] }]);
  egal("nu s-a mișcat nimic altceva: cantitatea livrată e tot zero și nu s-a făcut nicio factură", [livrat(K1), q(`SELECT COUNT(*) AS n FROM facturi WHERE partener_id = ${PART}`)[0].n], [[0, 0, 0], "0"]);
  egal("istoricul comenzii: cine, la ce produs, din ce în ce", istoric(K1), [["Depozit Sl", "Status · SL Punga", "gata de livrare", "livrată"]]);
  r = await cer("get", `/comenzi/${K1}`, DEPOZIT);
  egal("pagina arată fiecare produs cu starea lui și cine a pus-o", [/^livrată pus de Depozit Sl, \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(celula(r.corp, a1)), celula(r.corp, a2), celula(r.corp, a3)], [true, "gata de livrare", "gata de livrare"]);
  r = await cer("get", "/comenzi", VALI);
  const randLista = (String(r.corp).split(`href="/comenzi/${K1}"`)[1] || "").split("</tr>")[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("lista de comenzi: sub statusul comenzii scrie „1 din 3 produse: 1 livrată”", /gata de livrare 1 din 3 produse: 1 livrată/.test(randLista), randLista.slice(0, 300));
  const randAlt = (String(r.corp).split(`href="/comenzi/${K2}"`)[1] || "").split("</tr>")[0];
  bine("…iar la comenzile fără stări pe produse nu scrie nimic în plus", !randAlt.includes("data-status-produse"));

  console.log("\n4. Mai multe produse deodată; toate la aceeași stare");
  r = await schimba(K1, DEPOZIT, [a2, a3], "in_livrare");
  egal("două produse bifate trec amândouă pe „în livrare”; comanda rămâne", [/2 produse trecute pe „în livrare”/.test(mesaj(r, "status_linii_ok")), stare(K1)], [true, { comanda: "gata_livrare", linii: ["livrata", "in_livrare", "in_livrare"] }]);
  r = await schimba(K1, DEPOZIT, [a2, a3], "livrata");
  egal("și ultimele două ajung „livrată”: toate produsele au aceeași stare, deci trece și comanda, iar produsele merg din nou cu ea", [/a trecut și comanda/.test(mesaj(r, "status_linii_ok")), stare(K1)], [true, { comanda: "livrata", linii: [null, null, null] }]);
  egal("…scris și în istoric, și la client", [istoric(K1).slice(-1)[0], q(`SELECT subiect FROM interactiuni WHERE partener_id = ${PART} ORDER BY id DESC LIMIT 1`)[0].subiect], [["Depozit Sl", "Status", "gata de livrare", "livrată — toate produsele au ajuns aici"], "Comanda SL-1: livrata"]);
  egal("cantitatea livrată tot neatinsă", livrat(K1), [0, 0, 0]);

  console.log("\n5. Comanda merge mai departe");
  const [b1, b2] = [idLinie(K3, P1), idLinie(K3, P2)];
  r = await schimba(K3, VALI, [b1], "in_stoc_depozit");
  egal("comanda „în producție”, un produs deja „în stoc depozit”", stare(K3), { comanda: "in_productie", linii: ["in_stoc_depozit", null] });
  await cer("post", `/comenzi/${K3}/status`, VALI, { body: { status: "productie_finalizata" } });
  r = await cer("get", `/comenzi/${K3}`, VALI);
  egal("comanda trece pe „producție finalizată”: produsul aflat înaintea ei rămâne „în stoc depozit”, celălalt merge cu comanda", [celula(r.corp, b1).split(" pus de")[0], celula(r.corp, b2)], ["în stoc depozit", "producție finalizată"]);
  await cer("post", `/comenzi/${K3}/status`, VALI, { body: { status: "gata_livrare" } });
  r = await cer("get", `/comenzi/${K3}`, VALI);
  egal("comanda îl depășește („gata de livrare”): de acum și produsul acela merge cu ea", [celula(r.corp, b1), celula(r.corp, b2)], ["gata de livrare", "gata de livrare"]);
  r = await schimba(K3, VALI, [b2], "in_productie");
  egal("un produs poate fi pus și ÎN URMA comenzii (încă în producție), iar „la fel ca toată comanda” îl aduce înapoi", [stare(K3).linii[1], (await schimba(K3, VALI, [b2], SL.RESET)) && stare(K3).linii[1]], ["in_productie", null]);

  console.log("\n6. Drepturi și refuzuri");
  r = await schimba(K3, AGENT, [b1], "livrata");
  egal("agentul nu poate pune „livrată” pe un produs (nici pe comandă nu poate)", [/nu e una dintre cele pe care le poți pune tu/.test(mesaj(r, "status_linii_eroare")), stare(K3).linii], [true, ["in_stoc_depozit", null]]);
  r = await schimba(K3, DEPOZIT, [a1], "livrata");
  egal("o linie din altă comandă nu se schimbă de aici", [/Bifează cel puțin un produs/.test(mesaj(r, "status_linii_eroare")), stare(K1).linii], [true, [null, null, null]]);
  r = await schimba(K3, DEPOZIT, [], "livrata");
  egal("nimic bifat: mesaj, nimic scris", /Bifează cel puțin un produs/.test(mesaj(r, "status_linii_eroare")), true);
  r = await cer("post", `/comenzi/${K3}/status-linii`, null, { body: { linie: [String(b1)], status: "livrata" } });
  egal("fără om logat: la pagina de intrare", unde(r), "/login");
  r = await schimba(K3, AGENT, [b2], "anulata");
  egal("agentul își poate anula un produs de pe comanda lui; comanda rămâne", [stare(K3), /SL Folie/.test(istoric(K3).slice(-1)[0][1])], [{ comanda: "gata_livrare", linii: ["in_stoc_depozit", "anulata"] }, true]);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
