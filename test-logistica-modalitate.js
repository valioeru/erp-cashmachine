"use strict";
// Modalitatea de livrare pe cursa de transport: ridicată de client, agent,
// camion propriu, dubă mică, altă modalitate (text liber). PostgreSQL real.
//
// CEREREA LUI VALI, 05.11.2026:
//   „La logistică trebuie să fie și varianta preluare de către client, sau
//    distribuită de agentul de vânzări, sau livrare cu camion propriu sau cu
//    dubă mică sau altă modalitate" · „Altă modalitate: scrie care e, liber."
//
// CE APĂRĂ:
//   • CURSA SE ÎNCHIDE ȘI FĂRĂ TRANSPORTATOR: modalitatea o trece pe
//     „alocată", apoi „Livrată" o închide (și comanda clientului).
//   • „ALTĂ MODALITATE" CERE TEXTUL; „AGENT" CERE UN AGENT ADEVĂRAT.
//   • RIDICAREA DE CĂTRE CLIENT N-ARE „PE DRUM": butonul spune „Ridicată".
//   • O CURSĂ DEJA ALOCATĂ NU SE SUPRASCRIE; „Schimbă modalitatea" o golește.
//   • COADA LOGISTICII SPUNE CU CINE PLEACĂ MARFA.
//   • DOAR CINE ARE VOIE LA LOGISTICĂ alege modalitatea.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
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
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const MOD = require(path.join(RAD, "lib", "livrare-modalitate.js"));
const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "logistica.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(metoda, cale, user, params, body, query) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: params || {}, query: query || {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const loc = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || ""));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const AGENT_ID = 97401;
function curata() {
  q("DELETE FROM transport_rezervari WHERE cursa_id IN (SELECT id FROM transport_curse WHERE client LIKE 'TEST-MOD%')");
  q("DELETE FROM transport_curse WHERE client LIKE 'TEST-MOD%'");
  q(`DELETE FROM utilizatori WHERE id = ${AGENT_ID}`);
}
const cursaNoua = (client) => Number(unul(`INSERT INTO transport_curse (client, localitate, stare) VALUES ('${client}', 'Ploiești', 'de_alocat') RETURNING id`));
const cursa = (id) => q(`SELECT stare, modalitate, modalitate_text, agent_id, vehicul, cost_estimat, transportator_id FROM transport_curse WHERE id = ${id}`)[0] || {};

(async () => {
  curata();
  const VALI = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali", rol: "admin" };
  const AGENT = { id: AGENT_ID, nume: "TEST-MOD Agent Ionescu", rol: "vanzari" };
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, activ) VALUES (${AGENT_ID}, 'TEST-MOD Agent Ionescu', 'test-mod-agent@exemplu.ro', 'x', 'x', 'vanzari', 1)`);

  console.log("\n1. Regula, fără bază de date");
  egal("cinci modalități, în afară de transportator", MOD.MODALITATI.map((m) => m[0]), ["client", "agent", "camion", "duba", "alta"]);
  bine("altă modalitate fără text e refuzată", !MOD.citeste({ modalitate: "alta" }, []).ok);
  bine("agent fără agent ales e refuzat", !MOD.citeste({ modalitate: "agent", agent_id: "5" }, [{ id: 6 }]).ok);
  bine("un cost care nu e număr e refuzat", !MOD.citeste({ modalitate: "camion", cost: "multi" }, []).ok);
  egal("costul cu virgulă se citește", MOD.citeste({ modalitate: "duba", cost: "120,5" }, []).cost, 120.5);
  egal("eticheta: agent cu numele lui", MOD.eticheta({ modalitate: "agent" }, "Ion"), "Agent: Ion");
  egal("eticheta: altă modalitate cu textul ei și mașina", MOD.eticheta({ modalitate: "alta", modalitate_text: "curier rapid", vehicul: "B 1 ABC" }), "Altă modalitate: curier rapid · B 1 ABC");
  bine("o modalitate inventată e refuzată", !MOD.citeste({ modalitate: "teleportare" }, []).ok);

  console.log("\n2. Ridicată de client");
  const c1 = cursaNoua("TEST-MOD Client 1");
  let pag = await cer("get", "/logistica/cursa/:id", VALI, { id: String(c1) });
  bine("pagina cursei are formularul cu cele cinci modalități", pag.corp.includes(`action="/logistica/cursa/${c1}/modalitate"`) && ["Ridicată de client", "Distribuită de agentul de vânzări", "Camion propriu", "Dubă mică", "Altă modalitate"].every((t) => pag.corp.includes(t)));
  bine("…cu agenții de vânzări în listă", pag.corp.includes("TEST-MOD Agent Ionescu"));
  // Câmpurile apar după ce alegi: textul liber la „altă modalitate", agentul
  // la „agent". Scriptul din pagină, rulat într-un Chromium adevărat.
  let chromium = null;
  try { chromium = require("playwright").chromium; } catch (_) {}
  if (chromium) {
    const br = await chromium.launch();
    try {
      const pg = await br.newPage();
      await pg.route("**/*", (rt) => rt.fulfill({ status: 200, body: "" }));
      await pg.setContent(pag.corp, { waitUntil: "domcontentloaded" });
      const vizibil = async () => pg.evaluate(() => ({
        text: getComputedStyle(document.querySelector('[name="modalitate_text"]').closest("label")).display !== "none",
        agent: getComputedStyle(document.querySelector('[name="agent_id"]').closest("label")).display !== "none",
      }));
      await pg.evaluate(() => { document.querySelector("details.card").open = true; });
      const inainte = await vizibil();
      await pg.selectOption('select[name="modalitate"]', "alta");
      const laAlta = await vizibil();
      await pg.selectOption('select[name="modalitate"]', "agent");
      const laAgent = await vizibil();
      egal("câmpurile apar la alegere (nimic / altă / agent)", [inainte, laAlta, laAgent],
        [{ text: false, agent: false }, { text: true, agent: false }, { text: false, agent: true }]);
    } finally {
      await br.close();
    }
  } else console.log("  (sar: playwright lipsește)");
  let r = await cer("post", "/logistica/cursa/:id/modalitate", AGENT, { id: String(c1) }, { modalitate: "client" });
  egal("agentul (fără drept la logistică) nu poate alege", cursa(c1).stare, "de_alocat");
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c1) }, { modalitate: "client" });
  egal("cursa trece pe alocată, ridicată de client", [cursa(c1).stare, cursa(c1).modalitate], ["alocata", "client"]);
  pag = await cer("get", "/logistica/cursa/:id", VALI, { id: String(c1) });
  bine("pagina spune „Livrare: Ridicată de client”", /Livrare: <strong>Ridicată de client<\/strong>/.test(pag.corp));
  bine("…fără „Pe drum”, cu butonul „Ridicată”", !pag.corp.includes("Pe drum — a plecat mașina") && pag.corp.includes("Ridicată — clientul a luat marfa"));
  bine("…și cu „Schimbă modalitatea”", pag.corp.includes("Schimbă modalitatea"));
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c1) }, { modalitate: "camion" });
  egal("o cursă alocată nu se suprascrie", cursa(c1).modalitate, "client");
  bine("…și spune de ce", /deja alocată/.test(loc(r)), loc(r));
  await cer("post", "/logistica/cursa/:id/livrata", VALI, { id: String(c1) }, { data: "2026-11-05" });
  egal("„Ridicată” o închide", cursa(c1).stare, "livrata");

  console.log("\n3. Altă modalitate, scrisă liber");
  const c2 = cursaNoua("TEST-MOD Client 2");
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c2) }, { modalitate: "alta", modalitate_text: "  " });
  egal("fără text rămâne de alocat", cursa(c2).stare, "de_alocat");
  bine("…cu motivul și formularul deschis", /scrie care e/.test(loc(r)) && /modalitate=1/.test(loc(r)), loc(r));
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c2) }, { modalitate: "alta", modalitate_text: "Curier rapid  Fan", vehicul: "B 99 XYZ", cost: "85" });
  egal("cu text se salvează (spațiile duble curățate)", [cursa(c2).modalitate, cursa(c2).modalitate_text, cursa(c2).vehicul, Number(cursa(c2).cost_estimat)], ["alta", "Curier rapid Fan", "B 99 XYZ", 85]);
  const coada = await cer("get", "/logistica", VALI, {}, {}, { stare: "deschise" });
  bine("coada logisticii spune „Altă modalitate: Curier rapid Fan”", coada.corp.includes("Altă modalitate: Curier rapid Fan · B 99 XYZ"));

  console.log("\n4. Distribuită de agent");
  const c3 = cursaNoua("TEST-MOD Client 3");
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c3) }, { modalitate: "agent", agent_id: String(VALI.id) });
  egal("un utilizator care nu e agent de vânzări e refuzat", cursa(c3).stare, "de_alocat");
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c3) }, { modalitate: "agent", agent_id: String(AGENT_ID) });
  egal("agentul de vânzări e primit", [cursa(c3).modalitate, Number(cursa(c3).agent_id)], ["agent", AGENT_ID]);
  const coada2 = await cer("get", "/logistica", VALI, {}, {}, { stare: "deschise" });
  bine("coada spune „Agent: TEST-MOD Agent Ionescu”", coada2.corp.includes("Agent: TEST-MOD Agent Ionescu"));
  pag = await cer("get", "/logistica/cursa/:id", VALI, { id: String(c3) });
  bine("la agent se poate apăsa „Pe drum”", pag.corp.includes("Pe drum — a plecat mașina"));

  console.log("\n5. Schimbă modalitatea");
  await cer("post", "/logistica/cursa/:id/dezaloca", VALI, { id: String(c3) });
  egal("cursa revine de alocat, fără nimic din modalitatea veche", cursa(c3), { stare: "de_alocat", modalitate: null, modalitate_text: null, agent_id: null, vehicul: null, cost_estimat: null, transportator_id: null });
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c3) }, { modalitate: "duba", cost: "abc" });
  egal("un cost greșit nu trece", cursa(c3).stare, "de_alocat");
  r = await cer("post", "/logistica/cursa/:id/modalitate", VALI, { id: String(c3) }, { modalitate: "duba" });
  egal("duba mică, fără cost", [cursa(c3).modalitate, cursa(c3).cost_estimat], ["duba", null]);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
