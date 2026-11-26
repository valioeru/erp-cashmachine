"use strict";
// Unificarea a doi parteneri: tot ce ține de unul trece pe celălalt.
//
// CEREREA LUI VALI, 26.11.2026: unificare pe clienți, cu sugestii, validată de
// mână (lib/unificare-clienti.js propune; modules/unificare-clienti.js arată).
//
// CE FACE O UNIFICARE, pentru perechea (păstrat, înghițit):
//   1. Tot ce trimite la partenerul înghițit — comenzi, facturi, oferte,
//      proforme, avize, contacte, emailuri, taskuri, comenzi la furnizor,
//      recepții… (lista TABELE) — trece pe cel păstrat.
//   2. Partenerul păstrat primește de la celălalt DOAR ce-i lipsea (CUI,
//      email, telefon, adresă, agent…). Ce avea scris nu se calcă.
//   3. Numele vechi rămâne ca alias, iar adresele celui înghițit (a firmei și
//      de livrare), dacă sunt altele, intră printre adresele de livrare ale
//      celui păstrat.
//   4. Rândul partenerului înghițit se scoate din `parteneri`. Partenerii n-au
//      un „activ = 0" pe care să-l respecte cele peste o sută de liste din
//      ERP; un rând lăsat pe loc ar fi rămas de ales la comandă.
//
// CE RĂMÂNE CA URMĂ, în `parteneri_fuziuni`: rândul întreg al partenerului
// scos, id-urile fiecărui rând mutat (pe tabel), ce s-a completat pe cel
// păstrat și ce s-a adăugat. Din ele, `desfa()` pune totul la loc: partenerul
// revine cu același id, iar rândurile mutate se întorc la el.
//
// TOTUL SAU NIMIC. Mutările, completarea, scoaterea rândului și urma se fac
// într-o SINGURĂ instrucțiune SQL: dacă pică ceva (o legătură neștiută, o
// restricție), nu rămâne nimic făcut pe jumătate.
//
// Lista de mai jos trebuie ținută la zi. Două paze:
//   • `nestiute()` citește schema reală și refuză unificarea dacă găsește o
//     coloană de partener care nu e nici în TABELE, nici în ALTCEVA;
//   • test-unificare-clienti.js verifică același lucru pe baza de test.
const db = require("./db");
const UC = require("./unificare-clienti");
const AL = require("./adresa-livrare");

const TABELE = [
  { tabel: "comenzi", coloana: "partener_id", ce: "comenzi" },
  { tabel: "facturi", coloana: "partener_id", ce: "facturi" },
  { tabel: "oferte", coloana: "partener_id", ce: "oferte" },
  { tabel: "proforme", coloana: "partener_id", ce: "proforme" },
  { tabel: "avize", coloana: "partener_id", ce: "avize" },
  { tabel: "contracte", coloana: "partener_id", ce: "contracte" },
  { tabel: "oportunitati", coloana: "partener_id", ce: "oportunități" },
  { tabel: "leaduri", coloana: "partener_id", ce: "leaduri" },
  { tabel: "mk_contacte", coloana: "partener_id", ce: "persoane de contact" },
  { tabel: "interactiuni", coloana: "partener_id", ce: "interacțiuni" },
  { tabel: "taskuri", coloana: "partener_id", ce: "taskuri" },
  { tabel: "emailuri", coloana: "partener_id", ce: "emailuri trimise" },
  { tabel: "email_mesaje", coloana: "partener_id", ce: "emailuri din inbox" },
  { tabel: "email_oferte", coloana: "partener_id", ce: "oferte primite pe email" },
  { tabel: "email_domenii", coloana: "partener_id", ce: "domenii de email" },
  { tabel: "notificari_facturi", coloana: "partener_id", ce: "notificări de factură" },
  { tabel: "inregistrari_contabile", coloana: "partener_id", ce: "înregistrări contabile" },
  { tabel: "concurenta_preturi", coloana: "partener_id", ce: "prețuri ale concurenței" },
  { tabel: "rezervari_agenti", coloana: "partener_id", ce: "rezervări de stoc" },
  { tabel: "rfq", coloana: "partener_id", ce: "cereri de preț (client)" },
  { tabel: "rfq", coloana: "furnizor_id", ce: "cereri de preț (furnizor)" },
  { tabel: "comenzi_productie", coloana: "partener_id", ce: "comenzi de producție (client)" },
  { tabel: "comenzi_productie", coloana: "furnizor_id", ce: "comenzi de producție (furnizor)" },
  { tabel: "comenzi_furnizor", coloana: "furnizor_id", ce: "comenzi la furnizor" },
  { tabel: "comenzi_linii", coloana: "furnizor_id", ce: "linii de comandă cu furnizorul lui" },
  { tabel: "receptii", coloana: "partener_id", ce: "recepții" },
  { tabel: "aprovizionari", coloana: "furnizor_id", ce: "cereri de aprovizionare" },
  { tabel: "ach_oferte", coloana: "furnizor_id", ce: "oferte de achiziție" },
  { tabel: "ct_paleti", coloana: "furnizor_id", ce: "paleți în CT-Park" },
  { tabel: "produse", coloana: "furnizor_id", ce: "produse cu furnizorul lui" },
  { tabel: "transportatori", coloana: "partener_id", ce: "transportatori" },
  { tabel: "alias_parteneri", coloana: "partener_id", ce: "aliasuri de nume" },
  { tabel: "parteneri_adrese_livrare", coloana: "partener_id", ce: "adrese de livrare" },
  // Cele două cu reguli ale lor, tratate mai jos (FEL).
  { tabel: "alocari_clienti", coloana: "partener_id", ce: "alocări pe agenți", fel: "alocari" },
  { tabel: "factoring_clienti", coloana: "partener_id", ce: "setări de factoring", fel: "factoring" },
];
// Coloane care seamănă la nume cu o legătură spre partener, dar nu sunt.
const ALTCEVA = new Set([
  "receptii.comanda_furnizor_id", // → comenzi_furnizor
  "receptii_linii.comanda_furnizor_linie_id", // → comenzi_furnizor_linii
  "parteneri_fuziuni.pastrat_id",
  "parteneri_fuziuni.inghitit_id",
]);
// Setări care țin id-ul unui partener (clientul Sameday din Comenzi Sameday).
const SETARI = ["sameday_partener_id"];
const cheie = (t) => `${t.tabel}.${t.coloana}`;

async function tabeleCareExista() {
  const r = await db
    .prepare("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'")
    .all();
  return new Set(r.map((x) => `${x.t}.${x.c}`));
}

// Coloane de partener din schema reală pe care motorul nu le știe. Cât lista
// asta nu e goală, unificarea se refuză: altfel ar rămâne rânduri agățate de
// un partener care nu mai există.
async function nestiute() {
  const r = await db
    .prepare(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('integer', 'bigint')
          AND (column_name LIKE '%partener%id' OR column_name LIKE '%furnizor%id')`
    )
    .all();
  const stiute = new Set(TABELE.map(cheie));
  return r.map((x) => `${x.t}.${x.c}`).filter((k) => !stiute.has(k) && !ALTCEVA.has(k)).sort();
}

const idBun = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

async function perechea(pastratId, inghititId) {
  const P = idBun(pastratId), O = idBun(inghititId);
  if (!P || !O || P === O) throw new Error("Alege doi parteneri diferiți: cel păstrat și cel care intră în el.");
  const pastrat = await db.prepare("SELECT * FROM parteneri WHERE id = ?").get(P);
  const inghitit = await db.prepare("SELECT * FROM parteneri WHERE id = ?").get(O);
  if (!pastrat) throw new Error("Partenerul păstrat nu mai există.");
  if (!inghitit) throw new Error("Partenerul de unificat nu mai există (poate a fost deja unificat).");
  return { P, O, pastrat, inghitit };
}

// Adresele celui înghițit care nu sunt deja printre ale celui păstrat.
async function adreseDeAdus(pastrat, inghitit) {
  const LL = require("./livrare-la");
  const alePastratului = LL.optiuni(pastrat, []).adrese.map((a) => a.text);
  const extra = await db
    .prepare("SELECT adresa FROM parteneri_adrese_livrare WHERE partener_id IN (?, ?) AND COALESCE(activ, 1) = 1")
    .all(pastrat.id, inghitit.id)
    .catch(() => []);
  const avute = alePastratului.concat(extra.map((x) => x.adresa)).map((x) => AL.cheie(x));
  const out = [];
  for (const a of LL.optiuni(inghitit, []).adrese) {
    const k = AL.cheie(a.text);
    if (!k || avute.includes(k)) continue;
    avute.push(k);
    out.push({ denumire: a.fel === "adresa de livrare" ? "livrare — " + String(inghitit.nume || "").slice(0, 40) : String(inghitit.nume || "").slice(0, 60), adresa: a.text });
  }
  return out;
}

// Ce s-ar întâmpla, fără să se întâmple nimic.
async function previzualizeaza(pastratId, inghititId) {
  const { P, O, pastrat, inghitit } = await perechea(pastratId, inghititId);
  const exista = await tabeleCareExista();
  const tabele = TABELE.filter((t) => exista.has(cheie(t)));
  const numara = await db
    .prepare(tabele.map((t) => `SELECT '${cheie(t)}' AS k, COUNT(*) AS n FROM ${t.tabel} WHERE ${t.coloana} = ${O}`).join(" UNION ALL "))
    .all();
  const cate = new Map(numara.map((r) => [r.k, Number(r.n)]));
  const randuri = tabele.map((t) => ({ cheie: cheie(t), ce: t.ce, n: cate.get(cheie(t)) || 0, fel: t.fel || "" })).filter((r) => r.n > 0);
  const note = [];
  if (randuri.some((r) => r.fel === "alocari")) {
    const are = await db.prepare("SELECT COUNT(*) AS n FROM alocari_clienti WHERE partener_id = ?").get(P);
    note.push(Number(are.n) > 0
      ? "Alocarea pe agenți rămâne a partenerului păstrat; a celui unificat se scoate (se pune la loc dacă desfaci unificarea)."
      : "Partenerul păstrat n-are alocare pe agenți: o preia pe a celui unificat.");
  }
  if (randuri.some((r) => r.fel === "factoring")) note.push("Dacă amândoi au factoring activ, rămâne activ doar al partenerului păstrat.");
  const completari = UC.completari(pastrat, inghitit);
  const adrese = await adreseDeAdus(pastrat, inghitit);
  const aliasNou = UC.cheieNume(pastrat.nume) !== UC.cheieNume(inghitit.nume) || String(pastrat.nume).trim() !== String(inghitit.nume).trim() ? String(inghitit.nume || "").trim() : "";
  return { pastrat, inghitit, randuri, total: randuri.reduce((a, r) => a + r.n, 0), completari, adrese, aliasNou, note, nestiute: await nestiute() };
}

// Unifică. Întoarce { id (al urmei), mutate, total }.
async function fuzioneaza(pastratId, inghititId, utilizatorId) {
  const v = await previzualizeaza(pastratId, inghititId);
  if (v.nestiute.length) {
    throw new Error("Unificarea e oprită: în bază sunt legături spre parteneri pe care motorul nu le știe (" + v.nestiute.join(", ") + "). Trebuie adăugate în lib/parteneri-fuziune.js.");
  }
  const P = Number(v.pastrat.id), O = Number(v.inghitit.id);
  const exista = await tabeleCareExista();
  const tabele = TABELE.filter((t) => exista.has(cheie(t)));
  const param = [];
  const pune = (x) => { param.push(x); return "?"; };
  const cte = [];
  const perechi = [];
  tabele.forEach((t, i) => {
    const nume = `m${i}`;
    if (t.fel === "alocari") {
      // Păstratul are alocare: a celui înghițit se scoate (ținută în urmă).
      cte.push(`alo_scoase AS (DELETE FROM alocari_clienti x WHERE x.partener_id = ${O} AND EXISTS (SELECT 1 FROM alocari_clienti y WHERE y.partener_id = ${P}) RETURNING to_jsonb(x.*) AS r)`);
      cte.push(`${nume} AS (UPDATE alocari_clienti x SET partener_id = ${P} WHERE x.partener_id = ${O} AND NOT EXISTS (SELECT 1 FROM alocari_clienti y WHERE y.partener_id = ${P}) RETURNING x.id)`);
    } else if (t.fel === "factoring") {
      // Un singur factoring activ pe partener (index unic): al păstratului.
      cte.push(`fac_oprite AS (SELECT x.id FROM factoring_clienti x WHERE x.partener_id = ${O} AND x.activ = 1 AND EXISTS (SELECT 1 FROM factoring_clienti y WHERE y.partener_id = ${P} AND y.activ = 1))`);
      cte.push(`${nume} AS (UPDATE factoring_clienti x SET partener_id = ${P}, activ = CASE WHEN x.id IN (SELECT id FROM fac_oprite) THEN 0 ELSE x.activ END WHERE x.partener_id = ${O} RETURNING x.id)`);
    } else {
      cte.push(`${nume} AS (UPDATE ${t.tabel} SET ${t.coloana} = ${P} WHERE ${t.coloana} = ${O} RETURNING id)`);
    }
    perechi.push(`'${cheie(t)}', (SELECT COALESCE(json_agg(id), '[]'::json) FROM ${nume})`);
  });
  const areAlocari = tabele.some((t) => t.fel === "alocari");
  const areFactoring = tabele.some((t) => t.fel === "factoring");

  const campuri = Object.keys(v.completari);
  if (campuri.length) {
    cte.push(`completat AS (UPDATE parteneri SET ${campuri.map((c) => `${c} = ${pune(v.completari[c])}`).join(", ")} WHERE id = ${P} RETURNING id)`);
  }
  cte.push(
    v.aliasNou
      ? `alias_nou AS (INSERT INTO alias_parteneri (alias, partener_id, sursa) SELECT ${pune(v.aliasNou)}, ${P}, 'unificare clienți' WHERE NOT EXISTS (SELECT 1 FROM alias_parteneri WHERE LOWER(alias) = LOWER(${pune(v.aliasNou)})) RETURNING id)`
      : "alias_nou AS (SELECT NULL::int AS id WHERE false)"
  );
  cte.push(
    v.adrese.length && exista.has("parteneri_adrese_livrare.partener_id")
      ? `adrese_noi AS (INSERT INTO parteneri_adrese_livrare (partener_id, denumire, adresa, creat_la, creat_de, activ) VALUES ${v.adrese.map((a) => `(${P}, ${pune(a.denumire)}, ${pune(a.adresa)}, ${pune(new Date().toISOString())}, ${pune(utilizatorId || null)}, 1)`).join(", ")} RETURNING id)`
      : "adrese_noi AS (SELECT NULL::int AS id WHERE false)"
  );
  cte.push(
    exista.has("setari_app.cheie")
      ? `setari_mutate AS (UPDATE setari_app SET valoare = '${P}' WHERE cheie IN (${SETARI.map((x) => `'${x}'`).join(", ")}) AND TRIM(valoare) = '${O}' RETURNING cheie)`
      : "setari_mutate AS (SELECT NULL::text AS cheie WHERE false)"
  );
  cte.push(`scos AS (DELETE FROM parteneri x WHERE x.id = ${O} RETURNING to_jsonb(x.*) AS r)`);
  const vechi = {};
  for (const c of campuri) vechi[c] = v.pastrat[c] === undefined ? null : v.pastrat[c];
  const sql = `WITH ${cte.join(",\n")}
    INSERT INTO parteneri_fuziuni (pastrat_id, inghitit_id, inghitit_nume, inghitit_cui, inghitit_rand, mutari, completari, adaugate, sterse, facut_de)
    SELECT ${P}, ${O}, (SELECT r->>'nume' FROM scos), (SELECT r->>'cui' FROM scos), (SELECT r::text FROM scos),
           json_build_object(${perechi.join(", ")})::text,
           ${pune(JSON.stringify(vechi))},
           json_build_object('alias', (SELECT COALESCE(json_agg(id), '[]'::json) FROM alias_nou), 'adrese', (SELECT COALESCE(json_agg(id), '[]'::json) FROM adrese_noi), 'setari', (SELECT COALESCE(json_agg(cheie), '[]'::json) FROM setari_mutate)${areFactoring ? ", 'factoring_oprite', (SELECT COALESCE(json_agg(id), '[]'::json) FROM fac_oprite)" : ""})::text,
           ${areAlocari ? "(SELECT COALESCE(json_agg(r), '[]'::json) FROM alo_scoase)::text" : "'[]'"},
           ${pune(utilizatorId || null)}
     WHERE EXISTS (SELECT 1 FROM scos)
    RETURNING id, mutari`;
  const r = await db.prepare(sql).get(...param);
  if (!r) throw new Error("Unificarea nu s-a făcut: partenerul de unificat nu mai există.");
  const mutate = JSON.parse(r.mutari || "{}");
  return { id: Number(r.id), mutate, total: Object.values(mutate).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0) };
}

// Desface o unificare: partenerul scos revine cu același id, rândurile mutate
// se întorc la el, iar partenerul păstrat își recapătă câmpurile de dinainte.
// Ce s-a făcut DUPĂ unificare pe partenerul păstrat rămâne la el.
async function desfa(fuziuneId, utilizatorId) {
  const f = await db.prepare("SELECT * FROM parteneri_fuziuni WHERE id = ?").get(idBun(fuziuneId));
  if (!f) throw new Error("Unificarea nu există.");
  if (f.desfacut_la) throw new Error("Unificarea asta a fost deja desfăcută.");
  const P = Number(f.pastrat_id), O = Number(f.inghitit_id);
  if (!(await db.prepare("SELECT id FROM parteneri WHERE id = ?").get(P))) {
    throw new Error("Partenerul păstrat nu mai există (a fost, la rândul lui, unificat în altul). Desfă întâi unificarea aceea.");
  }
  if (await db.prepare("SELECT id FROM parteneri WHERE id = ?").get(O)) throw new Error("Partenerul scos există din nou în bază; nu mai am ce pune la loc.");
  const mutari = JSON.parse(f.mutari || "{}");
  const vechi = JSON.parse(f.completari || "{}");
  const adaugate = JSON.parse(f.adaugate || "{}");
  const sterse = JSON.parse(f.sterse || "[]");
  const exista = await tabeleCareExista();
  const ids = (l) => (Array.isArray(l) ? l.map(Number).filter((x) => x > 0) : []);
  const param = [];
  const pune = (x) => { param.push(x); return "?"; };
  const cte = [`revenit AS (INSERT INTO parteneri SELECT * FROM jsonb_populate_record(NULL::parteneri, ${pune(f.inghitit_rand)}::jsonb) RETURNING id)`];
  let i = 0;
  for (const t of TABELE) {
    const l = ids(mutari[cheie(t)]);
    if (!l.length || !exista.has(cheie(t))) continue;
    const reporniri = t.fel === "factoring" ? ids(adaugate.factoring_oprite) : [];
    cte.push(
      `b${i++} AS (UPDATE ${t.tabel} SET ${t.coloana} = ${O}${reporniri.length ? `, activ = CASE WHEN id IN (${reporniri.join(",")}) THEN 1 ELSE activ END` : ""} WHERE id IN (${l.join(",")}) AND ${t.coloana} = ${P} RETURNING id)`
    );
  }
  const campuri = Object.keys(vechi).filter((c) => UC.CAMPURI_COMPLETATE.includes(c) || c === "tip" || c === "stare");
  if (campuri.length) cte.push(`necompletat AS (UPDATE parteneri SET ${campuri.map((c) => `${c} = ${pune(vechi[c])}`).join(", ")} WHERE id = ${P} RETURNING id)`);
  if (ids(adaugate.alias).length) cte.push(`fara_alias AS (DELETE FROM alias_parteneri WHERE id IN (${ids(adaugate.alias).join(",")}) AND partener_id = ${P} RETURNING id)`);
  if (ids(adaugate.adrese).length && exista.has("parteneri_adrese_livrare.partener_id")) cte.push(`fara_adrese AS (DELETE FROM parteneri_adrese_livrare WHERE id IN (${ids(adaugate.adrese).join(",")}) AND partener_id = ${P} RETURNING id)`);
  const setari = (Array.isArray(adaugate.setari) ? adaugate.setari : []).filter((x) => SETARI.includes(x));
  if (setari.length) cte.push(`setari_inapoi AS (UPDATE setari_app SET valoare = '${O}' WHERE cheie IN (${setari.map((x) => `'${x}'`).join(", ")}) AND TRIM(valoare) = '${P}' RETURNING cheie)`);
  if (sterse.length) cte.push(`alo_inapoi AS (INSERT INTO alocari_clienti SELECT * FROM jsonb_populate_recordset(NULL::alocari_clienti, ${pune(JSON.stringify(sterse))}::jsonb) RETURNING id)`);
  const r = await db
    .prepare(`WITH ${cte.join(",\n")}
      UPDATE parteneri_fuziuni SET desfacut_la = ${pune(new Date().toISOString())}, desfacut_de = ${pune(utilizatorId || null)}
       WHERE id = ${Number(f.id)} AND EXISTS (SELECT 1 FROM revenit) RETURNING id`)
    .get(...param);
  if (!r) throw new Error("Desfacerea nu s-a făcut.");
  return { pastrat: P, revenit: O };
}

// Unde a ajuns un partener care nu mai există (pentru legăturile vechi).
async function undeAAjuns(id) {
  let cur = idBun(id);
  for (let pas = 0; pas < 5 && cur; pas++) {
    const f = await db
      .prepare("SELECT pastrat_id FROM parteneri_fuziuni WHERE inghitit_id = ? AND desfacut_la IS NULL ORDER BY id DESC LIMIT 1")
      .get(cur)
      .catch(() => null);
    if (!f) return pas ? cur : 0;
    cur = Number(f.pastrat_id);
    if (await db.prepare("SELECT id FROM parteneri WHERE id = ?").get(cur)) return cur;
  }
  return 0;
}

module.exports = { TABELE, ALTCEVA, SETARI, nestiute, previzualizeaza, fuzioneaza, desfa, undeAAjuns };
