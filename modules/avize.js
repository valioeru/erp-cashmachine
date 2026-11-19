"use strict";
// Avizele de însoțire a mărfii: emiterea, lista, avizul manual, anularea.
//
// CE A CERUT VALI, 03.11.2026 (vezi și lib/aviz.js, foaia tipărită):
//   • la ieșirea din depozit pe o comandă de client se emite aviz, fără
//     prețuri, în locul etichetei (modules/ct-park.js cheamă `emite`);
//   • „Fă și pagină de generare aviz manual din Financiar, tot așa, cu
//     adăugare produse și fără preț; ține minte aceeași numerotare”;
//   • „Gabi Tecuceanu să aibă acces la avize de acolo” — de-aia avizele au
//     bifa lor, „Avize” (lib/auth.js), nu atârnă de Financiar;
//   • numărul comenzii apare pe aviz, iar dacă nu e, nu se pune.
//
// NUMEROTAREA. Un singur contor pentru toate avizele, în setari_app
// (aviz_serie, aviz_urmator), pornit de la CHMA 1389 — continuarea avizului
// CHMA 1388 din SmartBill. Numărul se ia și avizul se scrie în ACEEAȘI
// instrucțiune SQL: două avize emise în aceeași secundă nu pot primi același
// număr, iar un aviz care nu se poate scrie nu „consumă” un număr. Indexul
// unic (serie, numar) e plasa de siguranță dacă cineva dă contorul înapoi.
//
// Un aviz emis nu se șterge și nu se modifică: e un document cu număr. Dacă e
// greșit, adminul îl anulează (numărul rămâne folosit, foaia arată ANULAT) și
// se emite altul.
const db = require("../lib/db");
const AV = require("../lib/aviz");
const { esc, layout, table, cautaClient, cautaClientScript, randuriClienti, subnavFinanciar, subnavDepozit, subnavComenzi } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa, areAvize } = require("../lib/auth");

const SERIE_IMPLICITA = "CHMA";
const URMATORUL_IMPLICIT = 1389;

// Data avizului e ziua din România, nu cea UTC a serverului: la 00:30 noaptea
// ar fi ieșit cu data de ieri.
function aziRo() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
}
const nr = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const eAdmin = (u) => Boolean(u && u.rol === "admin");

// AGENTUL ȘI AVIZELE (Vali, 18.11.2026: „lasă-i să facă și avize de însoțire").
// Cine are bifa „Avize" lucrează pe toți clienții, ca până acum. Agentul fără
// bifă intră pe ușa din lib/auth.js și lucrează doar pe clienții lui: e agentul
// de pe fișa clientului sau are clientul alocat. Vede avizele făcute de el și
// pe cele ale clienților lui; contorul și anularea rămân la administrator.
const SQL_CLIENT_AL_LUI = (p) =>
  `(${p}.agent_id = ? OR EXISTS (SELECT 1 FROM alocari_clienti ac WHERE ac.partener_id = ${p}.id AND ac.utilizator_id = ?))`;
async function eClientulLui(user, partenerId) {
  const id = Number(user && user.id);
  if (!(id > 0) || !nr(partenerId)) return false;
  const r = await db.prepare(`SELECT p.id FROM parteneri p WHERE p.id = ? AND ${SQL_CLIENT_AL_LUI("p")}`).get(nr(partenerId), id, id).catch(() => null);
  return Boolean(r);
}
async function poateVedea(user, aviz) {
  if (areAvize(user)) return true;
  if (!user || !aviz) return false;
  if (Number(aviz.creat_de_id) === Number(user.id)) return true;
  return eClientulLui(user, aviz.partener_id);
}

// Seria și numărul următor ale firmei care emite. Fiecare firmă are șirul ei
// (Vali, 19.11.2026): Cash Machine pe cheile vechi, Warehouse All pe „_wa".
function cheiContor(firma) {
  const f = AV.firmaEmitenta(firma);
  return { f, cSerie: "aviz_serie" + f.sufix, cUrmator: "aviz_urmator" + f.sufix };
}
async function contor(firma) {
  const { f, cSerie, cUrmator } = cheiContor(firma);
  const r = await db.prepare("SELECT cheie, valoare FROM setari_app WHERE cheie IN (?, ?)").all(cSerie, cUrmator);
  const m = {};
  for (const x of r || []) m[x.cheie] = x.valoare;
  return { serie: String(m[cSerie] || f.serieAviz), urmator: Number(m[cUrmator]) || f.urmatorAviz };
}

// Emiterea unui aviz. `linii` = [{ produs_id, denumire, cod, um, cantitate, palet }].
// Întoarce { id, serie, numar }. Aruncă o eroare cu mesaj de om dacă nu se poate.
// `firma` = 'cm' (Cash Machine, și când lipsește) sau 'wa' (Warehouse All).
async function emite({ partenerId, comandaId, comandaNumar, linii, creatDe, creatDeId, sursa, delegat, transport, observatii, firma }) {
  const { f: FE, cSerie, cUrmator } = cheiContor(firma);
  const curate = AV.agrega(linii);
  if (!curate.length) throw new Error("Avizul n-are nicio linie cu produs și cantitate.");
  const p = nr(partenerId)
    ? await db.prepare("SELECT id, nume, cui, reg_com, adresa, judet, localitate, tara FROM parteneri WHERE id = ?").get(nr(partenerId))
    : null;
  if (!p) throw new Error("Clientul avizului nu există în ERP.");

  const azi = aziRo();
  // Rândurile contorului le pune migrarea; aici e doar plasa, ca o bază fără
  // ele să nu dea „avizul n-a primit număr”.
  await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?) ON CONFLICT (cheie) DO NOTHING").run(cSerie, FE.serieAviz, azi);
  await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?) ON CONFLICT (cheie) DO NOTHING").run(cUrmator, String(FE.urmatorAviz), azi);
  const { serie } = await contor(FE.cheie);

  let rand;
  try {
    rand = await db
      .prepare(
        `WITH nr AS (
           UPDATE setari_app SET valoare = CAST(CAST(valoare AS INTEGER) + 1 AS TEXT), actualizat_la = ?
            WHERE cheie = ?
            RETURNING CAST(valoare AS INTEGER) - 1 AS numar
         )
         INSERT INTO avize (serie, numar, data, partener_id, comanda_id, comanda_numar, client_nume, client_cui, client_regcom, client_adresa,
                            furnizor, firma, sursa, delegat, mijloc_transport, observatii, creat_de, creat_de_id)
         SELECT ?, nr.numar, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM nr
         RETURNING id, serie, numar`
      )
      .get(
        azi,
        cUrmator,
        serie,
        azi,
        p.id,
        nr(comandaId),
        String(comandaNumar || "").trim() || null,
        p.nume,
        p.cui || null,
        String(p.reg_com || "").trim() || null,
        AV.adresaClient(p) || null,
        JSON.stringify(FE.date),
        FE.cheie,
        sursa === "depozit" ? "depozit" : "manual",
        String(delegat || "").trim() || null,
        String(transport || "").trim() || null,
        String(observatii || "").trim() || null,
        creatDe || null,
        nr(creatDeId)
      );
  } catch (e) {
    if (/ux_avize_serie_numar|duplicate key/i.test(String(e.message))) {
      const { urmator } = await contor(FE.cheie).catch(() => ({ urmator: "?" }));
      throw new Error(
        `Numărul ${urmator} din seria ${serie} (${FE.eticheta}) e deja folosit pe alt aviz. Un administrator trebuie să corecteze contorul din Avize.`
      );
    }
    throw e;
  }
  if (!rand || !rand.id) throw new Error("Avizul n-a primit număr: contorul de avize lipsește.");

  const valori = [];
  const semne = curate
    .map((l) => {
      valori.push(rand.id, l.produs_id || null, l.denumire, l.cod || null, l.um || null, l.cantitate, l.paleti.join(", ") || null);
      return "(?, ?, ?, ?, ?, ?, ?)";
    })
    .join(", ");
  await db.prepare(`INSERT INTO avize_linii (aviz_id, produs_id, denumire, cod, um, cantitate, paleti) VALUES ${semne}`).run(...valori);
  console.log(`[avize] ${rand.serie} ${rand.numar} (${FE.eticheta}) pentru ${p.nume} (${sursa || "manual"}) de ${creatDe || "?"}`);
  return { id: Number(rand.id), serie: rand.serie, numar: Number(rand.numar) };
}

async function citeste(id) {
  const aviz = await db.prepare("SELECT * FROM avize WHERE id = ?").get(nr(id));
  if (!aviz) return null;
  const linii = await db.prepare("SELECT * FROM avize_linii WHERE aviz_id = ? ORDER BY id").all(aviz.id);
  return { aviz, linii };
}

// AWB-ul transportului care duce marfa de pe aviz, ca să intre pe aviz cu
// codul lui de bare. Întâi cursa născută din ieșirea care a emis avizul — aia
// e sigur a lui. Altfel, cursa comenzii, dar numai dacă e una singură cu AWB:
// la o comandă livrată în tranșe, fiecare tranșă are avizul și AWB-ul ei, și
// a le pune pe toate pe fiecare aviz ar însemna să greșim pe toate.
async function awbAviz(aviz) {
  if (!aviz) return [];
  const prinIesire = await db
    .prepare(
      `SELECT DISTINCT TRIM(tc.awb) AS awb FROM transport_curse tc
         JOIN ct_iesiri i ON i.id = tc.iesire_id
        WHERE i.aviz_id = ? AND COALESCE(TRIM(tc.awb), '') <> '' AND tc.stare <> 'anulata'`
    )
    .all(aviz.id)
    .catch(() => []);
  if (prinIesire.length) return prinIesire.map((r) => r.awb);
  if (!nr(aviz.comanda_id)) return [];
  const prinComanda = await db
    .prepare(
      `SELECT DISTINCT TRIM(awb) AS awb FROM transport_curse
        WHERE comanda_id = ? AND COALESCE(TRIM(awb), '') <> '' AND stare <> 'anulata'`
    )
    .all(nr(aviz.comanda_id))
    .catch(() => []);
  return prinComanda.length === 1 ? [prinComanda[0].awb] : [];
}

// Subnavigația potrivită omului: Financiar pentru cine îl are, altfel
// Depozit. Cine are doar bifa „Avize” vede pagina fără subnavigație.
function subnav(user, activ) {
  if (poateAccesa(user, "/financiar")) return subnavFinanciar(activ, user);
  if (poateAccesa(user, "/depozit")) return subnavDepozit(activ, user);
  return subnavComenzi(activ, user);
}

function register(router) {
  // ---- Lista ---------------------------------------------------------------
  router.get("/avize", async (ctx) => {
    const tot = areAvize(ctx.user);
    const eu = Number(ctx.user && ctx.user.id) || 0;
    const lista = await db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM avize_linii l WHERE l.aviz_id = a.id) AS nr_linii
           FROM avize a LEFT JOIN parteneri p ON p.id = a.partener_id
          WHERE ${tot ? "1 = 1" : `(a.creat_de_id = ? OR ${SQL_CLIENT_AL_LUI("p")})`}
          ORDER BY a.serie, a.numar DESC LIMIT 300`
      )
      .all(...(tot ? [] : [eu, eu, eu]));
    const c = await contor();
    const q = ctx.query || {};
    const mesaj = q.ok ? `<div class="flash">${esc(q.ok)}</div>` : "";
    const eroare = q.eroare ? `<p style="color:var(--danger);max-width:760px">${esc(q.eroare)}</p>` : "";

    // Contoarele celorlalte firme care emit (Warehouse All).
    const alte = [];
    for (const f of AV.FIRME_EMITENTE.slice(1)) alte.push({ f, c: await contor(f.cheie) });
    const formContor = eAdmin(ctx.user)
      ? `<details style="margin-top:22px;max-width:760px">
           <summary style="cursor:pointer;font-weight:600">Seria și numărul următor (doar administratorul)</summary>
           ${alte
             .map(
               (x) => `<form method="post" action="/avize/contor" class="form" style="margin-top:10px" data-contor-firma="${x.f.cheie}">
             <input type="hidden" name="firma" value="${x.f.cheie}">
             <div style="display:grid;grid-template-columns:160px 160px 200px auto;gap:12px;align-items:end">
               <div style="font-weight:600;padding-bottom:8px">${esc(x.f.eticheta)}</div>
               <label class="field"><span>Seria</span><input name="serie" value="${esc(x.c.serie)}" maxlength="10" required></label>
               <label class="field"><span>Următorul număr</span><input name="urmator" type="number" min="1" step="1" value="${esc(String(x.c.urmator))}" required></label>
               <div><button class="btn" type="submit">Salvează</button></div>
             </div>
           </form>`
             )
             .join("")}
           <form method="post" action="/avize/contor" class="form" style="margin-top:10px" data-contor-firma="cm">
             <input type="hidden" name="firma" value="cm">
             <div style="display:grid;grid-template-columns:160px 160px 200px auto;gap:12px;align-items:end">
               <div style="font-weight:600;padding-bottom:8px">Cash Machine</div>
               <label class="field"><span>Seria</span><input name="serie" value="${esc(c.serie)}" maxlength="10" required></label>
               <label class="field"><span>Următorul număr</span><input name="urmator" type="number" min="1" step="1" value="${esc(String(c.urmator))}" required></label>
               <div><button class="btn" type="submit">Salvează</button></div>
             </div>
             <p class="ajutor" style="margin-top:8px">
               Fiecare firmă are seria și numerele ei; două firme nu pot avea aceeași serie.
               Numerotarea continuă de la avizele din SmartBill (CHMA 1388). Dacă se mai emit avize pe aceeași serie și din
               SmartBill, numerele se dublează — scoate avizele pe seria asta doar de aici, sau folosește aici altă serie.
               Un număr deja folosit în seria aleasă nu se poate pune.
             </p>
           </form>
         </details>`
      : "";

    // Unde e SmartBill pe aceeași serie (lib/serii-smartbill.js).
    const SS = require("../lib/serii-smartbill");
    const stSb = SS.stare(c, await require("./punte-rute").seriaVazuta(db, "aviz"), "aviz");
    const blocSb = `<p data-smartbill-serie="${stSb.fel}" style="max-width:820px;font-size:13px;${
      stSb.fel === "in-urma" ? "border-left:4px solid var(--warn);padding:8px 12px;background:var(--surface-2,#faf7ef)" : "color:var(--text-muted)"
    }">${esc(stSb.text)}</p>`;
    const body = `
      ${subnav(ctx.user, "/avize")}
      ${mesaj}${eroare}
      ${blocSb}
      <div class="toolbar">
        <a class="btn" href="/avize/nou">+ Aviz nou</a>
        <span style="color:var(--text-muted);font-size:13px;margin-left:8px">Următorul aviz: <strong>${esc(c.serie)} ${esc(String(c.urmator))}</strong>${alte
          .map((x) => ` · ${esc(x.f.eticheta)}: <strong>${esc(x.c.serie)} ${esc(String(x.c.urmator))}</strong>`)
          .join("")}${
          tot ? "" : ` · <span data-doar-ale-mele>vezi avizele tale și ale clienților tăi</span>`
        }</span>
      </div>
      ${
        lista.length
          ? table(
              ["Aviz", "Firma", "Data", "Client", "Comanda", "Linii", "De unde", "Întocmit de", "Stare"],
              lista.map((a) => [
                `<a href="/avize/${a.id}" target="_blank"><strong>${esc(a.serie)} ${esc(String(a.numar))}</strong></a>
                 <a href="/avize/${a.id}?pdf=1" target="_blank" class="btn secondary small" data-pdf="${a.id}" title="Deschide avizul și fereastra de salvare ca PDF" style="margin-left:6px">PDF</a>`,
                esc(AV.firmaEmitenta(a.firma).eticheta),
                esc(AV.dataAviz(a.data)),
                esc(a.client_nume || "—"),
                esc(a.comanda_numar || "—"),
                esc(String(a.nr_linii || 0)),
                a.sursa === "depozit" ? "ieșire din depozit" : "manual",
                esc(a.creat_de || "—"),
                Number(a.anulat) === 1 ? `<span class="badge rosu">anulat</span>` : `<span class="badge verde">emis</span>`,
              ])
            )
          : `<p style="color:var(--text-muted)">Niciun aviz încă. Avizele apar aici când scoți marfă din depozit pe o comandă, sau când faci unul manual.</p>`
      }
      ${formContor}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Avize de însoțire", active: "/avize", body }));
  });

  // ---- Contorul (doar admin) ---------------------------------------------------
  router.post("/avize/contor", async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent("Doar administratorul poate schimba seria și numărul."));
    const { f: FE, cSerie, cUrmator } = cheiContor(ctx.body.firma);
    const serie = String(ctx.body.serie || "").trim().toUpperCase();
    const urmator = nr(ctx.body.urmator);
    if (!/^[A-Z0-9-]{1,10}$/.test(serie)) return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent("Seria: litere, cifre sau cratimă, cel mult 10."));
    // Două firme nu pot împărți o serie: numerele s-ar călca între ele.
    for (const alta of AV.FIRME_EMITENTE) {
      if (alta.cheie === FE.cheie) continue;
      if ((await contor(alta.cheie)).serie === serie) {
        return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent(`Seria ${serie} e a firmei ${alta.eticheta}. Alege altă serie pentru ${FE.eticheta}.`));
      }
    }
    if (!urmator) return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent("Următorul număr trebuie să fie un întreg mai mare ca 0."));
    const max = await db.prepare("SELECT MAX(numar) AS m FROM avize WHERE serie = ?").get(serie);
    const ultim = Number((max && max.m) || 0);
    if (urmator <= ultim) {
      return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent(`În seria ${serie} există deja avize până la nr. ${ultim}. Următorul poate fi cel puțin ${ultim + 1}.`));
    }
    const azi = aziRo();
    await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?) ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, actualizat_la = EXCLUDED.actualizat_la").run(cSerie, serie, azi);
    await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?) ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, actualizat_la = EXCLUDED.actualizat_la").run(cUrmator, String(urmator), azi);
    console.log(`[avize] contor schimbat (${FE.eticheta}): ${serie} ${urmator} de ${ctx.user.nume}`);
    redirect(ctx.res, "/avize?ok=" + encodeURIComponent(`Următorul aviz ${FE.eticheta} va fi ${serie} ${urmator}.`));
  });

  // ---- Avizul manual -----------------------------------------------------------
  async function formular(ctx, { eroare, valori } = {}) {
    const v = valori || {};
    const tot = areAvize(ctx.user);
    const eu = Number(ctx.user && ctx.user.id) || 0;
    const parteneri = await db
      .prepare(`SELECT p.id, p.nume, p.cui, p.agent_id FROM parteneri p WHERE p.tip != 'furnizor' AND ${tot ? "1 = 1" : SQL_CLIENT_AL_LUI("p")} ORDER BY p.nume`)
      .all(...(tot ? [] : [eu, eu]));
    const agenti = await db.prepare("SELECT id, nume FROM utilizatori ORDER BY nume").all();
    const produse = await db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod, denumire, unitate_masura FROM produse
          WHERE COALESCE(activ, 1) = 1 ORDER BY denumire`
      )
      .all();
    const comenzi = await db
      .prepare(`SELECT c.numar, p.nume AS client FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.numar IS NOT NULL AND c.numar <> '' AND ${tot ? "1 = 1" : SQL_CLIENT_AL_LUI("p")} ORDER BY c.id DESC LIMIT 300`)
      .all(...(tot ? [] : [eu, eu]))
      .catch(() => []);
    const c = await contor();
    const linii = Array.isArray(v.linii) && v.linii.length ? v.linii : [{}, {}, {}];
    // Produsul se alege dintr-o listă în care scrie „COD — Denumire”. Ce nu e
    // în catalog se poate scrie liber: și asta merge pe aviz.
    const optiuni = produse
      .map((p) => `<option value="${esc((p.cod ? p.cod + " — " : "") + p.denumire)}" data-um="${esc(p.unitate_masura || "")}">`)
      .join("");
    const randLinie = (l) => `<tr class="aviz-rand">
        <td><input name="produs[]" list="aviz-produse" value="${esc(l.produs || "")}" placeholder="caută după cod sau denumire, sau scrie liber" style="width:100%"></td>
        <td><input name="um[]" value="${esc(l.um || "")}" placeholder="buc" style="width:90px"></td>
        <td><input name="cantitate[]" value="${esc(l.cantitate || "")}" inputmode="decimal" placeholder="0" style="width:110px;text-align:right"></td>
        <td><button type="button" class="link-btn danger aviz-scoate" title="Scoate rândul">×</button></td>
      </tr>`;

    const body = `
      ${subnav(ctx.user, "/avize")}
      ${eroare ? `<p class="alerta" style="max-width:820px;color:var(--danger);border:1px solid var(--danger);border-radius:8px;padding:10px 12px">${esc(eroare)}</p>` : ""}
      <h1 style="margin:6px 0 2px">Aviz de însoțire nou</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:820px">
        ${tot ? "" : `<span data-doar-clientii-mei>Poți face avize pentru clienții tăi.</span> `}Fără prețuri: clientul, produsele și cantitățile. Primește numărul următor din seria firmei alese
        (la Cash Machine, același șir ca avizele scoase din depozit) și data de azi, ${esc(AV.dataAviz(aziRo()))}.
      </p>
      <form method="post" action="/avize" class="form" style="max-width:980px">
        ${AV.alegeFirma(v.firma)}
        <p class="ajutor" style="margin:-4px 0 12px">${(
          await Promise.all(AV.FIRME_EMITENTE.map(async (f) => `${esc(f.eticheta)}: următorul număr <strong>${esc((await contor(f.cheie)).serie)} ${esc(String((await contor(f.cheie)).urmator))}</strong>`))
        ).join(" · ")}. Pe aviz apar datele firmei alese.</p>
        <label class="field"><span>Client</span>
          ${cautaClient({ nume: "client_cautat", obligatoriu: true, partenerId: v.partener_id, valoare: (parteneri.find((p) => String(p.id) === String(v.partener_id)) || {}).nume })}
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <label class="field"><span>Nr. comandă (opțional)</span><input name="comanda_numar" list="aviz-comenzi" value="${esc(v.comanda_numar || "")}" placeholder="dacă nu e, nu apare pe aviz"></label>
          <label class="field"><span>Numele delegatului (opțional)</span><input name="delegat" value="${esc(v.delegat || "")}"></label>
          <label class="field"><span>Mijloc de transport (opțional)</span><input name="transport" value="${esc(v.transport || "")}" placeholder="de ex. B 123 ABC"></label>
        </div>
        <h2>Produse</h2>
        <table class="table" style="max-width:980px">
          <thead><tr><th>Produs</th><th>U.M.</th><th>Cantitate</th><th></th></tr></thead>
          <tbody id="aviz-linii">${linii.map(randLinie).join("")}</tbody>
        </table>
        <button type="button" class="btn small secondary" id="aviz-adauga" style="margin-top:8px">+ Adaugă produs</button>
        <label class="field" style="margin-top:14px"><span>Observații (opțional, apar pe aviz)</span><textarea name="observatii" rows="2">${esc(v.observatii || "")}</textarea></label>
        <div class="form-actions">
          <button class="btn" type="submit">Emite avizul</button>
          <a class="btn secondary" href="/avize">Renunță</a>
        </div>
      </form>
      <datalist id="aviz-produse">${optiuni}</datalist>
      <datalist id="aviz-comenzi">${comenzi.map((x) => `<option value="${esc(x.numar)}">${esc(x.client || "")}</option>`).join("")}</datalist>
      <template id="aviz-sablon">${randLinie({})}</template>
      ${cautaClientScript(randuriClienti(parteneri, agenti))}
      <script>
      (function () {
        var tb = document.getElementById("aviz-linii");
        var dl = document.getElementById("aviz-produse");
        var um = {};
        dl.querySelectorAll("option").forEach(function (o) { um[o.value] = o.getAttribute("data-um") || ""; });
        document.getElementById("aviz-adauga").addEventListener("click", function () {
          tb.appendChild(document.getElementById("aviz-sablon").content.cloneNode(true));
        });
        tb.addEventListener("click", function (ev) {
          var b = ev.target.closest(".aviz-scoate");
          if (!b) return;
          if (tb.querySelectorAll("tr.aviz-rand").length <= 1) { b.closest("tr").querySelectorAll("input").forEach(function (i) { i.value = ""; }); return; }
          b.closest("tr").remove();
        });
        // U.M.-ul produsului ales din catalog, dacă omul n-a scris altul.
        tb.addEventListener("change", function (ev) {
          if (ev.target.name !== "produs[]") return;
          var u = ev.target.closest("tr").querySelector('[name="um[]"]');
          if (u && !u.value && um[ev.target.value]) u.value = um[ev.target.value];
        });
      })();
      </script>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Aviz nou", active: "/avize", body }));
  }

  // „Fă aviz" de pe pagina comenzii: /avize/nou?comanda=<id> vine cu clientul,
  // numărul comenzii și liniile ei gata scrise; omul le îndreaptă și emite.
  async function valoriDinComanda(ctx) {
    const id = nr(ctx.query && ctx.query.comanda);
    if (!id) return null;
    const c = await db.prepare("SELECT id, numar, partener_id, status FROM comenzi WHERE id = ?").get(id).catch(() => null);
    if (!c) return null;
    if (!areAvize(ctx.user) && !(await eClientulLui(ctx.user, c.partener_id))) return { eroare: "Comanda nu e a unui client de-al tău: poți face avize doar pentru clienții tăi." };
    const linii = await db
      .prepare(
        `SELECT cl.cantitate, cl.um, pr.denumire, pr.unitate_masura, COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod
           FROM comenzi_linii cl JOIN produse pr ON pr.id = cl.produs_id WHERE cl.comanda_id = ? ORDER BY cl.id`
      )
      .all(c.id);
    return {
      valori: {
        partener_id: c.partener_id,
        comanda_numar: String(c.numar || "").trim(),
        linii: linii.map((l) => ({ produs: (l.cod ? l.cod + " — " : "") + l.denumire, um: String(l.um || l.unitate_masura || ""), cantitate: String(Number(l.cantitate)).replace(".", ",") })),
      },
    };
  }

  router.get("/avize/nou", async (ctx) => {
    const d = await valoriDinComanda(ctx);
    await formular(ctx, d ? { eroare: d.eroare, valori: d.valori } : undefined);
  });

  // Produsul scris în căsuță: „COD — Denumire” din listă, codul singur, sau
  // denumirea exactă. Ce nu se găsește rămâne text liber, cu U.M.-ul scris.
  async function produsDinText(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const parti = t.split(" — ");
    const cod = parti.length > 1 ? parti[0].trim() : t;
    const gasit =
      (await db
        .prepare("SELECT id, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod, denumire, unitate_masura FROM produse WHERE (TRIM(cod) = ? OR cod_generat = ?) AND COALESCE(activ, 1) = 1 ORDER BY id LIMIT 1")
        .get(cod, cod)) ||
      (await db
        .prepare("SELECT id, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod, denumire, unitate_masura FROM produse WHERE LOWER(denumire) = LOWER(?) AND COALESCE(activ, 1) = 1 ORDER BY id LIMIT 1")
        .get(parti.length > 1 ? parti.slice(1).join(" — ").trim() : t));
    return gasit || { id: null, cod: null, denumire: t, unitate_masura: null };
  }

  router.post("/avize", async (ctx) => {
    const b = ctx.body || {};
    const produseScrise = [].concat(b["produs[]"] || b.produs || []);
    const umuri = [].concat(b["um[]"] || b.um || []);
    const cantitati = [].concat(b["cantitate[]"] || b.cantitate || []);
    const valori = {
      firma: AV.firmaEmitenta(b.firma).cheie,
      partener_id: b.partener_id,
      comanda_numar: b.comanda_numar,
      delegat: b.delegat,
      transport: b.transport,
      observatii: b.observatii,
      linii: produseScrise.map((p, i) => ({ produs: p, um: umuri[i], cantitate: cantitati[i] })),
    };
    const inapoi = (eroare) => formular(ctx, { eroare, valori });

    if (!nr(b.partener_id)) return inapoi("Alege clientul din listă — avizul nu poate pleca fără el.");
    if (!areAvize(ctx.user) && !(await eClientulLui(ctx.user, b.partener_id))) {
      return inapoi("Poți face avize doar pentru clienții tăi. Pentru alt client, vorbește cu agentul lui sau cu cineva care are Avizele.");
    }
    const linii = [];
    for (let i = 0; i < produseScrise.length; i++) {
      const text = String(produseScrise[i] || "").trim();
      const brut = String(cantitati[i] || "").trim();
      if (!text && !brut) continue;
      const cant = Number(brut.replace(/\s/g, "").replace(",", "."));
      if (!text) return inapoi(`Rândul ${i + 1} are cantitate, dar niciun produs.`);
      if (!(Number.isFinite(cant) && cant > 0)) return inapoi(`Rândul ${i + 1} (${text}): scrie o cantitate mai mare ca 0.`);
      const p = await produsDinText(text);
      linii.push({
        produs_id: p.id,
        denumire: p.denumire,
        cod: p.cod,
        um: String(umuri[i] || "").trim() || p.unitate_masura || "",
        cantitate: cant,
      });
    }
    if (!linii.length) return inapoi("Adaugă cel puțin un produs, cu cantitate.");

    // Comanda, dacă numărul scris e al unei comenzi din ERP.
    const numar = String(b.comanda_numar || "").trim();
    const comanda = numar ? await db.prepare("SELECT id, numar FROM comenzi WHERE numar = ? ORDER BY id DESC LIMIT 1").get(numar).catch(() => null) : null;
    try {
      const a = await emite({
        partenerId: b.partener_id,
        comandaId: comanda ? comanda.id : null,
        comandaNumar: numar || null,
        linii,
        creatDe: ctx.user ? ctx.user.nume : null,
        creatDeId: ctx.user ? ctx.user.id : null,
        sursa: "manual",
        firma: valori.firma,
        delegat: b.delegat,
        transport: b.transport,
        observatii: b.observatii,
      });
      redirect(ctx.res, `/avize/${a.id}`);
    } catch (e) {
      return inapoi(e.message);
    }
  });

  // ---- Foaia avizului -------------------------------------------------------------
  // Aceeași foaie, de pe două adrese: /avize/:id pentru cine are bifa Avize,
  // /stocuri/ct-park/aviz/:id pentru depozitul care tocmai a scos marfa (el
  // n-are neapărat bifa Avize, dar avizul ieșirii lui trebuie să-l tipărească).
  async function foaie(ctx, inapoi) {
    const r = await citeste(ctx.params.id);
    if (!r) return send(ctx.res, 404, layout({ user: ctx.user, title: "Aviz negăsit", active: "/avize", body: "<p>Avizul nu există.</p>" }));
    const { aviz, linii } = r;
    // Pe ușa agentului (/avize/:id) se văd doar avizele lui și ale clienților
    // lui. Adresa depozitului (/stocuri/ct-park/aviz/:id) are drepturile ei.
    if (inapoi.anulare && !(await poateVedea(ctx.user, aviz))) {
      return send(
        ctx.res,
        403,
        layout({ user: ctx.user, title: "Avizul altui client", active: "/avize", body: `${subnav(ctx.user, "/avize")}<h1>Avizul nu e al unui client de-al tău</h1><p>Poți deschide avizele făcute de tine și pe cele ale clienților tăi.</p><a class="btn secondary" href="/avize">Înapoi la avize</a>` })
      );
    }
    const q = ctx.query || {};
    const paleti = String(q.paleti || "").replace(/[^0-9,]/g, "");
    const bara = [
      `<strong>Aviz ${esc(aviz.serie)} nr. ${esc(String(aviz.numar))}</strong>${Number(aviz.anulat) === 1 ? ' · <span class="eroare">ANULAT</span>' : ""}`,
      `<button onclick="window.print()">Tipărește</button>`,
      // Vali, 19.11.2026: „la facturi, avize, proforme să poți și salva PDF;
      // orice user care le vede poate." Butonul e în bara foii, deci îl are
      // oricine poate deschide avizul.
      `<button onclick="window.print()" title="În fereastra de tipărire alege „Salvează ca PDF”" data-pdf-aviz>Descarcă PDF</button>`,
      `<a href="${esc(inapoi.href)}">${esc(inapoi.text)}</a>`,
      paleti ? `<a href="/stocuri/ct-park/etichete?paleti=${esc(paleti)}" target="_blank">etichetele paleților (A4)</a>` : "",
      q.mesaj ? `<span>${esc(q.mesaj)}</span>` : "",
      eAdmin(ctx.user) && Number(aviz.anulat) !== 1 && inapoi.anulare
        ? `<form method="post" action="/avize/${aviz.id}/anuleaza" style="display:inline" onsubmit="return confirm('Anulezi avizul ${esc(aviz.serie)} ${esc(String(aviz.numar))}? Numărul rămâne folosit.')">
             <input name="motiv" placeholder="motivul anulării" required style="width:180px"> <button type="submit">Anulează</button></form>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    send(ctx.res, 200, AV.pagina(aviz, linii, { bara, awb: await awbAviz(aviz) }));
  }
  router.get("/avize/:id", async (ctx) => {
    await foaie(ctx, { href: "/avize", text: "toate avizele", anulare: true });
  });
  router.get("/stocuri/ct-park/aviz/:id", async (ctx) => {
    const q = ctx.query || {};
    const palet = nr(q.palet);
    await foaie(ctx, palet ? { href: `/stocuri/ct-park/palet/${palet}`, text: "înapoi la palet" } : { href: "/stocuri/ct-park", text: "înapoi la depozit" });
  });

  // ---- Anularea (doar admin) ------------------------------------------------------
  router.post("/avize/:id/anuleaza", async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent("Doar administratorul poate anula un aviz."));
    const motiv = String((ctx.body && ctx.body.motiv) || "").trim();
    const aviz = await db.prepare("SELECT id, serie, numar, anulat FROM avize WHERE id = ?").get(nr(ctx.params.id));
    if (!aviz) return redirect(ctx.res, "/avize");
    if (!motiv) return redirect(ctx.res, "/avize?eroare=" + encodeURIComponent("Scrie motivul anulării."));
    await db.prepare("UPDATE avize SET anulat = 1, motiv_anulare = ? WHERE id = ?").run(`${motiv} (${ctx.user.nume}, ${AV.dataAviz(aziRo())})`, aviz.id);
    console.log(`[avize] anulat ${aviz.serie} ${aviz.numar} de ${ctx.user.nume}: ${motiv}`);
    redirect(ctx.res, "/avize?ok=" + encodeURIComponent(`Avizul ${aviz.serie} ${aviz.numar} e anulat. Numărul rămâne folosit.`));
  });
}

module.exports = { register, emite, citeste, contor, aziRo, awbAviz, eClientulLui, poateVedea };
