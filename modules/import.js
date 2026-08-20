"use strict";
// Modul de import — aduce în ERP datele existente deja în SmartBill.
//
// IMPORTANT (verificat, vezi și README): API-ul public SmartBill e gândit
// pentru emiterea de documente noi și interogarea stocului curent, NU pentru
// exportul în masă al istoricului (facturi vechi, parteneri, rețete, bonuri
// de consum, stocuri pe gestiuni). Acele date există doar în interfața web
// SmartBill Gestiune/Facturare, sub formă de rapoarte exportabile (Excel).
// De-aia importul de mai jos lucrează cu fișiere exportate de utilizator,
// nu cu apeluri API — e singura cale reală de a le aduce în ERP.
// Singurul lucru pe care API-ul chiar îl oferă e stocul curent (GET
// /stocks) — pentru asta există un buton separat de sincronizare live, mai
// jos ("Sincronizează stocul curent"), care chiar apelează SmartBill.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const smartbill = require("../lib/smartbill");
const { xlsxDisponibil, normalizeHeader, gasesteColoana, parseFisier, parseNumar, parseData } = require("../lib/import-utils");

const ALIASE = {
  serie: ["serie", "seria"],
  numar: ["numar", "nr", "numardocument", "nrdocument", "numarfactura"],
  serieNumar: ["serieinumarul", "seriasinumarul", "seriasinumaruldocumentuluiemis", "document", "numardocumentemis"],
  client: ["client", "partener", "furnizor", "denumireclient", "denumirepartener", "denumire", "nume", "numeclient", "numefurnizor", "numepartener"],
  cui: ["cui", "cif", "codfiscal", "cuicnp", "cifcui"],
  email: ["email", "emailclient", "adresaemail"],
  telefon: ["telefon", "tel", "nrtelefon"],
  adresa: ["adresa", "adresaclient", "adresasediu"],
  dataEmiterii: ["dataemiterii", "data", "dataemitere", "dataemis", "datadocument"],
  dataScadenta: ["datascadenta", "scadenta"],
  faraTva: ["valoarefaratva", "subtotal", "valoarenet", "fatva", "netfaratva", "valoarenetalei", "valoarenetlei"],
  tva: ["valoaretva", "tva", "sumatva", "tvalei"],
  total: ["total", "valoaretotala", "totalcutva", "valoare", "totallei", "valoaretotal"],
  status: ["status", "stare"],
  gestiune: ["gestiune", "depozit", "gestiunea"],
  produs: ["produs", "denumireprodus", "articol", "denumirearticol"],
  cod: ["cod", "codprodus", "codarticol"],
  cantitate: ["cantitate", "cant"],
  um: ["um", "unitatemasura", "unitate"],
  pretUnitar: ["pretunitar", "pret", "pretachizitie"],
  bonNumar: ["bonnumar", "numarbon", "nrbon", "bon"],
  produsFinit: ["produsfinit", "produsfinal", "denumireprodusfinit"],
  componenta: ["componenta", "denumirecomponenta", "materieprima", "semifabricat"],
  componentaCant: ["cantitatenecesara", "cantitatecomponenta"],
};

function mapColoane(header, chei) {
  const idx = {};
  for (const key of Object.keys(chei)) idx[key] = gasesteColoana(header, chei[key]);
  return idx;
}

function statusDinText(text) {
  const t = (text || "").toLowerCase();
  if (/anulat|stornat/.test(t)) return "anulata";
  // ATENȚIE: "neachitat"/"neplătit" conțin literal substring-urile
  // "achitat"/"platit" — verificăm negația ÎNAINTE de cuvântul pozitiv,
  // altfel o factură neplătită ar fi clasificată greșit ca plătită (bug
  // real, prins la testare cu statusul "Neachitat").
  const negat = /\bne\s*(achitat|platit|plătit|incasat|încasat)/.test(t) || /nu\s+(e|este|a fost)\s+(achitat|platit|plătit|incasat|încasat)/.test(t);
  if (negat) return "emisa";
  if (/partial|parțial/.test(t)) return "platita_partial";
  if (/achitat|platit|plătit|incasat|încasat/.test(t)) return "platita";
  return "emisa";
}

async function gasesteSauCreeazaPartener(nume, cui, tipDorit, cache) {
  const cheie = (cui || nume || "").toLowerCase().trim();
  if (!cheie) return { id: null, nou: false };
  if (cache.has(cheie)) return { id: cache.get(cheie), nou: false };
  let existent = null;
  if (cui) existent = await db.prepare("SELECT id, tip FROM parteneri WHERE LOWER(cui) = LOWER(?) AND cui != ''").get(cui);
  if (!existent && nume) existent = await db.prepare("SELECT id, tip FROM parteneri WHERE LOWER(nume) = LOWER(?)").get(nume);
  let id;
  let nou = false;
  if (existent) {
    id = existent.id;
    if (existent.tip !== tipDorit && existent.tip !== "ambele") {
      await db.prepare("UPDATE parteneri SET tip = 'ambele' WHERE id = ?").run(id);
    }
  } else {
    const ins = await db.prepare("INSERT INTO parteneri (tip, nume, cui) VALUES (?, ?, ?) RETURNING id").run(tipDorit, nume || "(fără nume)", cui || null);
    id = ins.lastInsertRowid;
    nou = true;
  }
  cache.set(cheie, id);
  return { id, nou };
}

async function gasesteSauCreeazaProdus(denumire, cod, cache) {
  const cheie = (cod || denumire || "").toLowerCase().trim();
  if (!cheie) return null;
  if (cache.has(cheie)) return cache.get(cheie);
  let existent = null;
  if (cod) existent = await db.prepare("SELECT id FROM produse WHERE LOWER(cod) = LOWER(?) AND cod != ''").get(cod);
  if (!existent && denumire) existent = await db.prepare("SELECT id FROM produse WHERE LOWER(denumire) = LOWER(?)").get(denumire);
  let id;
  if (existent) {
    id = existent.id;
  } else {
    const ins = await db.prepare("INSERT INTO produse (cod, denumire) VALUES (?, ?) RETURNING id").run(cod || null, denumire || "(fără denumire)");
    id = ins.lastInsertRowid;
  }
  cache.set(cheie, id);
  return id;
}

async function gasesteSauCreeazaDepozit(denumire, cache) {
  const cheie = (denumire || "Depozit implicit").toLowerCase().trim();
  if (cache.has(cheie)) return cache.get(cheie);
  let existent = await db.prepare("SELECT id FROM depozite WHERE LOWER(denumire) = LOWER(?)").get(denumire || "Depozit implicit");
  let id;
  if (existent) id = existent.id;
  else id = (await db.prepare("INSERT INTO depozite (denumire) VALUES (?) RETURNING id").run(denumire || "Depozit implicit")).lastInsertRowid;
  cache.set(cheie, id);
  return id;
}

function paginaRezultat(titlu, rezumat, erori) {
  const body = `
    <div class="detail-box">
      <div class="detail-grid">
        ${Object.entries(rezumat)
          .map(([k, v]) => `<div><div class="k">${esc(k)}</div>${esc(v)}</div>`)
          .join("")}
      </div>
    </div>
    ${
      erori.length
        ? `<h2>Rânduri cu probleme (${erori.length})</h2><ul>${erori
            .slice(0, 50)
            .map((e) => `<li>${esc(e)}</li>`)
            .join("")}</ul>${erori.length > 50 ? `<p>...și încă ${erori.length - 50}.</p>` : ""}`
        : ""
    }
    <a href="/import" class="btn secondary">Înapoi la Import</a>
  `;
  return layout({ title: titlu, active: "/import", body });
}

function register(router) {
  router.get("/import", async (ctx) => {
    const stats = {
      parteneri: (await db.prepare("SELECT COUNT(*) n FROM parteneri").get()).n,
      facturiVanzare: (await db.prepare("SELECT COUNT(*) n FROM facturi WHERE directie='vanzare'").get()).n,
      facturiAchizitie: (await db.prepare("SELECT COUNT(*) n FROM facturi WHERE directie='achizitie'").get()).n,
      produse: (await db.prepare("SELECT COUNT(*) n FROM produse").get()).n,
      miscariStoc: (await db.prepare("SELECT COUNT(*) n FROM miscari_stoc").get()).n,
      reteteComponente: (await db.prepare("SELECT COUNT(*) n FROM retete_componente").get()).n,
    };

    const body = `
      <div class="detail-box">
        <p>SmartBill nu oferă un API public pentru extragerea în masă a istoricului (facturi vechi, parteneri, stocuri pe gestiuni, rețete, bonuri de consum) — API-ul lor e construit pentru emiterea de documente noi, nu pentru export. Soluția: exporți rapoartele din contul tău SmartBill (Excel/.xlsx, sau salvate ca .csv) și le încarci mai jos — importul e sigur de rulat de mai multe ori, rândurile deja existente sunt sărite automat, fără duplicate.</p>
        <p style="font-size:13px;color:var(--text-muted)">${
          xlsxDisponibil()
            ? "Fișierele .xlsx sunt acceptate direct."
            : "⚠️ Suportul .xlsx nu e disponibil momentan pe server — exportă fișierele ca .csv (Fișier → Salvare ca → CSV)."
        }</p>
      </div>

      <h2>Stare curentă</h2>
      ${table(
        ["Parteneri", "Facturi vânzare", "Facturi achiziție", "Produse", "Mișcări de stoc", "Rânduri rețete (BOM)"],
        [[stats.parteneri, stats.facturiVanzare, stats.facturiAchizitie, stats.produse, stats.miscariStoc, stats.reteteComponente]]
      )}

      <h2>1. Facturi emise (vânzări) și facturi de achiziție</h2>
      <p style="font-size:13px;color:var(--text-muted)">SmartBill Facturare → Rapoarte → Facturi emise → interval → Export Excel. Pentru achiziții, exportă echivalentul din Gestiune (facturi de intrare / achiziții) — dacă nu găsești un export direct, spune-mi exact ce vezi în meniu.</p>
      <form method="post" action="/import/facturi" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Tip document</span>
          <select name="directie">
            <option value="vanzare">Facturi emise (vânzări către clienți)</option>
            <option value="achizitie">Facturi de achiziție (de la furnizori)</option>
          </select>
        </label>
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă facturi</button>
      </form>

      <h2>2. Parteneri (clienți / furnizori)</h2>
      <p style="font-size:13px;color:var(--text-muted)">Dacă ai un export separat cu lista de parteneri (nume, CUI, email, telefon, adresă) — opțional, parteneri se creează oricum automat din facturi.</p>
      <form method="post" action="/import/parteneri" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Tip implicit (dacă fișierul nu specifică)</span>
          <select name="tip_implicit"><option value="client">Client</option><option value="furnizor">Furnizor</option></select>
        </label>
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă parteneri</button>
      </form>

      <h2>3. Stoc pe gestiuni (depozite)</h2>
      <p style="font-size:13px;color:var(--text-muted)">Coloane așteptate: gestiune/depozit, produs (sau cod), cantitate, opțional preț. Se adaugă ca "intrare" de stoc inițial.</p>
      <form method="post" action="/import/stoc" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă stoc</button>
      </form>

      <h2>4. Bonuri de consum intern</h2>
      <p style="font-size:13px;color:var(--text-muted)">Coloane așteptate: nr. bon, gestiune, produs, cantitate, dată. Se adaugă ca "ieșire" de stoc.</p>
      <form method="post" action="/import/consum" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă bonuri de consum</button>
      </form>

      <h2>5. Rețete de produs (BOM)</h2>
      <p style="font-size:13px;color:var(--text-muted)">Coloane așteptate: produs finit, componentă, cantitate necesară. Poți adăuga/edita rețete și manual, din pagina fiecărui produs.</p>
      <form method="post" action="/import/retete" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă rețete</button>
      </form>

      <h2>6. Sincronizare stoc curent (live, prin API-ul SmartBill)</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        ${
          smartbill.isConfigured()
            ? "Acesta e singurul import care chiar cheamă API-ul SmartBill în timp real (nu fișier). Structura exactă a răspunsului nu a fost încă testată contra contului tău real — la primul test, dacă formatul nu se potrivește, ajustăm rapid."
            : "Nu e disponibil — lipsesc variabilele SMARTBILL_* (vezi README)."
        }
      </p>
      ${
        smartbill.isConfigured()
          ? `<form method="post" action="/import/sincronizare-stoc-live" class="inline-form"><button type="submit" class="btn secondary">Sincronizează stocul curent din SmartBill</button></form>`
          : ""
      }

      <h2>Date demonstrative</h2>
      <p>Dacă mai există datele demonstrative puse inițial (parteneri Alfa/Beta/Gamma, produse exemplu etc.) și vrei să pornești curat înainte de import:</p>
      <form method="post" action="/import/curata-tot" class="inline-form" onsubmit="return confirm('Sigur ștergi TOATE datele din aplicație (parteneri, produse, comenzi, facturi, stocuri, angajați, CRM etc.)? Nu poate fi anulat.')">
        <button type="submit" class="link-btn danger">Șterge toate datele și pornește curat</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Import din SmartBill", active: "/import", body }));
  });

  router.post("/import/curata-tot", async (ctx) => {
    await db.exec(
      `TRUNCATE plati, facturi_linii, facturi, comenzi_linii, comenzi, interactiuni, oportunitati, retete_componente, miscari_stoc, salarii, angajati, produse, depozite, parteneri RESTART IDENTITY CASCADE;`
    );
    redirect(ctx.res, "/import");
  });

  function preiaFisier(ctx) {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    return files[0] || null;
  }

  // ---- 1. Facturi (vânzări/achiziții) -----------------------------------
  router.post("/import/facturi", async (ctx) => {
    const directie = ctx.body.directie === "achizitie" ? "achizitie" : "vanzare";
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import facturi", { Eroare: "Nu ai selectat niciun fișier." }, []));

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import facturi", { Eroare: e.message }, []));
    }
    if (!rows.length) return send(ctx.res, 200, paginaRezultat("Import facturi", { Eroare: "Fișierul pare gol." }, []));

    const header = rows[0].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.client === -1 || (idx.serie === -1 && idx.numar === -1 && idx.serieNumar === -1)) {
      return send(
        ctx.res,
        200,
        paginaRezultat(
          "Import facturi — coloane nerecunoscute",
          { "Coloane găsite în fișier": rows[0].join(" | ") || "(niciuna)" },
          ["Nu am putut identifica sigur coloanele de client și serie/număr document. Verifică denumirile coloanelor sau spune-mi exact ce coloane are fișierul."]
        )
      );
    }

    let create = 0,
      skip = 0,
      err = 0,
      parteneriNoi = 0;
    const erori = [];
    const cacheParteneri = new Map();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      try {
        let serie, numar;
        if (idx.serie !== -1 && idx.numar !== -1) {
          serie = String(row[idx.serie] || "").trim() || "IMP";
          numar = parseInt(String(row[idx.numar]).replace(/[^0-9]/g, ""), 10);
        } else {
          const combo = String(row[idx.serieNumar] || "").trim();
          const m = combo.match(/^([A-Za-z]+)[\s\-\/]*([0-9]+)/);
          if (m) {
            serie = m[1];
            numar = parseInt(m[2], 10);
          } else {
            serie = "IMP";
            numar = parseInt(combo.replace(/[^0-9]/g, ""), 10);
          }
        }
        if (!numar || isNaN(numar)) {
          err++;
          erori.push(`Rând ${r + 1}: nu am găsit un număr de document valid.`);
          continue;
        }

        const numeClient = idx.client !== -1 ? String(row[idx.client] || "").trim() : "";
        if (!numeClient) {
          err++;
          erori.push(`Rând ${r + 1}: lipsește numele clientului/furnizorului.`);
          continue;
        }
        const cui = idx.cui !== -1 ? String(row[idx.cui] || "").trim() : "";

        const dataEmiterii = idx.dataEmiterii !== -1 ? parseData(row[idx.dataEmiterii]) : null;
        const dataScadenta = idx.dataScadenta !== -1 ? parseData(row[idx.dataScadenta]) : null;
        const faraTva = idx.faraTva !== -1 ? parseNumar(row[idx.faraTva]) : 0;
        const tva = idx.tva !== -1 ? parseNumar(row[idx.tva]) : 0;
        const total = idx.total !== -1 ? parseNumar(row[idx.total]) : faraTva + tva;
        const statusText = idx.status !== -1 ? String(row[idx.status] || "") : "";
        const status = statusDinText(statusText);

        const { id: partenerId, nou: partenerNou } = await gasesteSauCreeazaPartener(numeClient, cui, directie === "achizitie" ? "furnizor" : "client", cacheParteneri);
        if (partenerNou) parteneriNoi++;

        const existenta = await db.prepare("SELECT id FROM facturi WHERE directie = ? AND serie = ? AND numar = ? AND partener_id = ?").get(directie, serie, numar, partenerId);
        if (existenta) {
          skip++;
          continue;
        }

        const insF = await db
          .prepare(
            "INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, observatii, sursa_import) VALUES (?, ?, ?, ?, ?, ?, ?, 'Import SmartBill', 'smartbill') RETURNING id"
          )
          .run(serie, numar, partenerId, directie, dataEmiterii || new Date().toISOString().slice(0, 10), dataScadenta || "", status);
        const facturaId = insF.lastInsertRowid;

        const cotaTva = faraTva > 0 && tva >= 0 ? Math.round((tva / faraTva) * 100) : 19;
        const pretLinie = faraTva > 0 ? faraTva : total / (1 + cotaTva / 100);
        await db
          .prepare("INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?)")
          .run(facturaId, `Conform document ${serie}-${numar} (import SmartBill, fără detaliu pe produse)`, 1, pretLinie, cotaTva);

        if (status === "platita") {
          await db
            .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (?, ?, ?, ?, ?)")
            .run(facturaId, total, dataEmiterii || "", "import", "Plată reconstituită automat din statusul din SmartBill");
        }
        create++;
      } catch (e) {
        err++;
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }

    send(
      ctx.res,
      200,
      paginaRezultat(`Import facturi ${directie === "achizitie" ? "achiziție" : "vânzare"} — rezultat`, {
        "Facturi importate": create,
        "Sărite (deja existau)": skip,
        "Parteneri noi creați": parteneriNoi,
        "Rânduri cu erori": err,
      }, erori)
    );
  });

  // ---- 2. Parteneri (import dedicat) ------------------------------------
  router.post("/import/parteneri", async (ctx) => {
    const tipImplicit = ctx.body.tip_implicit === "furnizor" ? "furnizor" : "client";
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import parteneri", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import parteneri", { Eroare: e.message }, []));
    }
    if (!rows.length) return send(ctx.res, 200, paginaRezultat("Import parteneri", { Eroare: "Fișierul pare gol." }, []));

    const header = rows[0].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.client === -1) {
      return send(ctx.res, 200, paginaRezultat("Import parteneri — coloane nerecunoscute", { "Coloane găsite": rows[0].join(" | ") }, ["Nu am găsit o coloană cu numele partenerului."]));
    }

    let create = 0,
      update = 0,
      err = 0;
    const erori = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      try {
        const nume = String(row[idx.client] || "").trim();
        if (!nume) {
          err++;
          erori.push(`Rând ${r + 1}: lipsește numele.`);
          continue;
        }
        const cui = idx.cui !== -1 ? String(row[idx.cui] || "").trim() : "";
        const email = idx.email !== -1 ? String(row[idx.email] || "").trim() : "";
        const telefon = idx.telefon !== -1 ? String(row[idx.telefon] || "").trim() : "";
        const adresa = idx.adresa !== -1 ? String(row[idx.adresa] || "").trim() : "";

        let existent = null;
        if (cui) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(cui) = LOWER(?) AND cui != ''").get(cui);
        if (!existent) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = LOWER(?)").get(nume);

        if (existent) {
          await db
            .prepare("UPDATE parteneri SET email = COALESCE(NULLIF(?, ''), email), telefon = COALESCE(NULLIF(?, ''), telefon), adresa = COALESCE(NULLIF(?, ''), adresa) WHERE id = ?")
            .run(email, telefon, adresa, existent.id);
          update++;
        } else {
          await db.prepare("INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa) VALUES (?, ?, ?, ?, ?, ?)").run(tipImplicit, nume, cui || null, email, telefon, adresa);
          create++;
        }
      } catch (e) {
        err++;
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }
    send(ctx.res, 200, paginaRezultat("Import parteneri — rezultat", { "Parteneri noi": create, "Parteneri actualizați": update, "Rânduri cu erori": err }, erori));
  });

  // ---- 3. Stoc pe gestiuni -----------------------------------------------
  router.post("/import/stoc", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import stoc", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import stoc", { Eroare: e.message }, []));
    }
    if (!rows.length) return send(ctx.res, 200, paginaRezultat("Import stoc", { Eroare: "Fișierul pare gol." }, []));

    const header = rows[0].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.produs === -1 && idx.cod === -1) {
      return send(ctx.res, 200, paginaRezultat("Import stoc — coloane nerecunoscute", { "Coloane găsite": rows[0].join(" | ") }, ["Nu am găsit o coloană cu produsul."]));
    }

    let create = 0,
      err = 0,
      produseNoi = 0,
      depoziteNoi = 0;
    const erori = [];
    const cacheProduse = new Map();
    const cacheDepozite = new Map();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      try {
        const denumire = idx.produs !== -1 ? String(row[idx.produs] || "").trim() : "";
        const cod = idx.cod !== -1 ? String(row[idx.cod] || "").trim() : "";
        if (!denumire && !cod) {
          err++;
          erori.push(`Rând ${r + 1}: lipsește produsul.`);
          continue;
        }
        const gestiune = idx.gestiune !== -1 ? String(row[idx.gestiune] || "").trim() : "Depozit implicit";
        const cantitate = idx.cantitate !== -1 ? parseNumar(row[idx.cantitate]) : 0;
        const pret = idx.pretUnitar !== -1 ? parseNumar(row[idx.pretUnitar]) : 0;
        if (!cantitate) {
          err++;
          erori.push(`Rând ${r + 1}: cantitate lipsă sau zero.`);
          continue;
        }

        const nrProduseInainte = cacheProduse.size;
        const produsId = await gasesteSauCreeazaProdus(denumire, cod, cacheProduse);
        if (cacheProduse.size > nrProduseInainte) produseNoi++;
        const nrDepoziteInainte = cacheDepozite.size;
        const depozitId = await gasesteSauCreeazaDepozit(gestiune, cacheDepozite);
        if (cacheDepozite.size > nrDepoziteInainte) depoziteNoi++;

        await db
          .prepare("INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, observatii) VALUES (?, ?, 'intrare', ?, ?, 'Import SmartBill', 'Stoc inițial din import')")
          .run(produsId, depozitId, cantitate, pret);
        create++;
      } catch (e) {
        err++;
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }
    send(ctx.res, 200, paginaRezultat("Import stoc pe gestiuni — rezultat", { "Mișcări create": create, "Produse noi": produseNoi, "Depozite noi": depoziteNoi, "Rânduri cu erori": err }, erori));
  });

  // ---- 4. Bonuri de consum intern ----------------------------------------
  router.post("/import/consum", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import bonuri de consum", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import bonuri de consum", { Eroare: e.message }, []));
    }
    if (!rows.length) return send(ctx.res, 200, paginaRezultat("Import bonuri de consum", { Eroare: "Fișierul pare gol." }, []));

    const header = rows[0].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.produs === -1 && idx.cod === -1) {
      return send(ctx.res, 200, paginaRezultat("Import bonuri de consum — coloane nerecunoscute", { "Coloane găsite": rows[0].join(" | ") }, ["Nu am găsit o coloană cu produsul."]));
    }

    let create = 0,
      err = 0;
    const erori = [];
    const cacheProduse = new Map();
    const cacheDepozite = new Map();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      try {
        const denumire = idx.produs !== -1 ? String(row[idx.produs] || "").trim() : "";
        const cod = idx.cod !== -1 ? String(row[idx.cod] || "").trim() : "";
        if (!denumire && !cod) {
          err++;
          erori.push(`Rând ${r + 1}: lipsește produsul.`);
          continue;
        }
        const gestiune = idx.gestiune !== -1 ? String(row[idx.gestiune] || "").trim() : "Depozit implicit";
        const cantitate = idx.cantitate !== -1 ? parseNumar(row[idx.cantitate]) : 0;
        const bonNr = idx.bonNumar !== -1 ? String(row[idx.bonNumar] || "").trim() : "";
        const data = idx.dataEmiterii !== -1 ? parseData(row[idx.dataEmiterii]) : null;
        if (!cantitate) {
          err++;
          erori.push(`Rând ${r + 1}: cantitate lipsă sau zero.`);
          continue;
        }

        const produsId = await gasesteSauCreeazaProdus(denumire, cod, cacheProduse);
        const depozitId = await gasesteSauCreeazaDepozit(gestiune, cacheDepozite);

        await db
          .prepare(
            "INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, data, document_ref, observatii) VALUES (?, ?, 'iesire', ?, ?, ?, 'Import SmartBill — bon de consum')"
          )
          .run(produsId, depozitId, cantitate, data || new Date().toISOString().slice(0, 10), bonNr || "Bon consum");
        create++;
      } catch (e) {
        err++;
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }
    send(ctx.res, 200, paginaRezultat("Import bonuri de consum — rezultat", { "Mișcări create": create, "Rânduri cu erori": err }, erori));
  });

  // ---- 5. Rețete de produs (BOM) -----------------------------------------
  router.post("/import/retete", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import rețete", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import rețete", { Eroare: e.message }, []));
    }
    if (!rows.length) return send(ctx.res, 200, paginaRezultat("Import rețete", { Eroare: "Fișierul pare gol." }, []));

    const header = rows[0].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    const idxFinit = idx.produsFinit !== -1 ? idx.produsFinit : idx.produs;
    const idxCantitate = idx.componentaCant !== -1 ? idx.componentaCant : idx.cantitate;
    if (idxFinit === -1 || idx.componenta === -1) {
      return send(
        ctx.res,
        200,
        paginaRezultat("Import rețete — coloane nerecunoscute", { "Coloane găsite": rows[0].join(" | ") }, [
          "Nu am găsit clar coloanele de produs finit și componentă. Fișierul trebuie să aibă o coloană separată pentru fiecare (ex: „Produs finit” și „Componentă”).",
        ])
      );
    }

    let create = 0,
      err = 0;
    const erori = [];
    const cacheProduse = new Map();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      try {
        const numeFinit = String(row[idxFinit] || "").trim();
        const numeComponenta = idx.componenta !== -1 ? String(row[idx.componenta] || "").trim() : "";
        const cantitate = idxCantitate !== -1 ? parseNumar(row[idxCantitate]) : 0;
        if (!numeFinit || !numeComponenta) {
          err++;
          erori.push(`Rând ${r + 1}: lipsește produsul finit sau componenta.`);
          continue;
        }
        if (!cantitate) {
          err++;
          erori.push(`Rând ${r + 1}: cantitate lipsă sau zero.`);
          continue;
        }

        const finitId = await gasesteSauCreeazaProdus(numeFinit, "", cacheProduse);
        const componentaId = await gasesteSauCreeazaProdus(numeComponenta, "", cacheProduse);
        if (finitId === componentaId) {
          err++;
          erori.push(`Rând ${r + 1}: produsul finit și componenta sunt identice.`);
          continue;
        }

        const existent = await db.prepare("SELECT id FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").get(finitId, componentaId);
        if (existent) {
          await db.prepare("UPDATE retete_componente SET cantitate = ? WHERE id = ?").run(cantitate, existent.id);
        } else {
          await db.prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)").run(finitId, componentaId, cantitate);
        }
        create++;
      } catch (e) {
        err++;
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }
    send(ctx.res, 200, paginaRezultat("Import rețete (BOM) — rezultat", { "Rânduri create/actualizate": create, "Rânduri cu erori": err }, erori));
  });

  // ---- 6. Sincronizare stoc curent, live prin API-ul SmartBill -----------
  router.post("/import/sincronizare-stoc-live", async (ctx) => {
    if (!smartbill.isConfigured()) return redirect(ctx.res, "/import");
    try {
      const raspuns = await smartbill.interogheazaStoc("");
      // Formatul exact al răspunsului nu a fost verificat contra unui cont
      // real — încercăm câteva forme plauzibile; dacă niciuna nu se
      // potrivește, afișăm răspunsul brut ca să putem ajusta rapid.
      const listaProduse = Array.isArray(raspuns) ? raspuns : raspuns.products || raspuns.list || raspuns.stocks || null;
      if (!Array.isArray(listaProduse)) {
        return send(
          ctx.res,
          200,
          paginaRezultat(
            "Sincronizare stoc SmartBill — format neașteptat",
            { Info: "Am primit un răspuns de la SmartBill, dar nu în formatul așteptat. Vezi mai jos răspunsul brut ca să ajustăm maparea." },
            [JSON.stringify(raspuns).slice(0, 2000)]
          )
        );
      }

      let actualizate = 0,
        err = 0;
      const erori = [];
      const cacheProduse = new Map();
      const cacheDepozite = new Map();
      for (const item of listaProduse) {
        try {
          const denumire = item.productName || item.name || item.denumire || "";
          const cantitate = Number(item.quantity ?? item.cantitate ?? 0);
          const gestiune = item.warehouseName || item.gestiune || "Depozit implicit";
          if (!denumire) continue;
          const produsId = await gasesteSauCreeazaProdus(denumire, item.productCode || "", cacheProduse);
          const depozitId = await gasesteSauCreeazaDepozit(gestiune, cacheDepozite);
          await db
            .prepare(
              "INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, document_ref, observatii) VALUES (?, ?, 'intrare', ?, 'Sincronizare SmartBill', 'Stoc curent din API SmartBill (snapshot)')"
            )
            .run(produsId, depozitId, cantitate);
          actualizate++;
        } catch (e) {
          err++;
          erori.push(e.message);
        }
      }
      send(ctx.res, 200, paginaRezultat("Sincronizare stoc SmartBill — rezultat", { "Produse sincronizate": actualizate, "Erori": err }, erori));
    } catch (e) {
      send(ctx.res, 200, paginaRezultat("Sincronizare stoc SmartBill — eroare", { Eroare: e.message }, []));
    }
  });
}

module.exports = { register };
