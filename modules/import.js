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
const { xlsxDisponibil, normalizeHeader, gasesteColoana, gasesteRandHeader, parseFisier, parseNumar, parseData } = require("../lib/import-utils");

const ALIASE = {
  serie: ["serie", "seria"],
  numar: ["numar", "nr", "numardocument", "nrdocument", "numarfactura"],
  serieNumar: ["factura", "serieinumarul", "seriasinumarul", "seriasinumaruldocumentuluiemis", "document", "numardocumentemis", "numefactura", "nrfactura", "documentemis"],
  client: ["client", "partener", "furnizor", "denumireclient", "denumirepartener", "denumire", "nume", "numeclient", "numefurnizor", "numepartener"],
  cui: ["cui", "cif", "codfiscal", "cuicnp", "cifcui"],
  email: ["email", "emailclient", "adresaemail"],
  telefon: ["telefon", "tel", "nrtelefon"],
  adresa: ["adresa", "adresaclient", "adresasediu"],
  dataEmiterii: ["dataemiterii", "data", "dataemitere", "dataemis", "datadocument"],
  dataScadenta: ["datascadentei", "datascadenta", "scadenta", "termendeplata"],
  faraTva: ["valoarefaratva", "subtotal", "valoarenet", "fatva", "netfaratva", "valoarenetalei", "valoarenetlei"],
  tva: ["valoaretva", "tva", "sumatva", "tvalei"],
  total: ["total", "valoaretotala", "totalcutva", "valoare", "totallei", "valoaretotal"],
  totalRon: ["valoaretotalaron", "valoaretotalalei", "totalron", "totallei", "valoareron"],
  moneda: ["moneda", "valuta"],
  observatii: ["observatii", "mentiuni", "note"],
  indexSpv: ["indexspv", "spv", "indexincarcarespv"],
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

// --- alocarea clienților pe agenți, din coloana Observații -----------------
// În SmartBill, la Cash Machine, numele agentului de vânzări se scrie în
// câmpul de observații al facturii (ex. "isabela radu" pe CSHMUPA0037).
// La import: dacă observațiile arată a nume de persoană, clientul e alocat
// acelui agent (utilizatorul se creează automat dacă nu există); clienții
// fără agent rămân alocați administratorului. Doar adminul poate schimba
// ulterior alocarea, din pagina partenerului.
function aratANumeDePersoana(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 40) return false;
  if (/[0-9@\/\\.,:;#%]/.test(t)) return false; // cifre/punctuație = nu e nume
  const cuvinte = t.split(/\s+/);
  if (cuvinte.length < 2 || cuvinte.length > 4) return false;
  return cuvinte.every((c) => /^[a-zA-ZăâîșțĂÂÎȘȚéÉ-]{2,}$/.test(c));
}

function numeFrumos(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
    .join(" ");
}

async function gasesteSauCreeazaAgent(numeBrut, cacheAgenti) {
  const nume = numeFrumos(numeBrut);
  const cheie = nume.toLowerCase();
  if (cacheAgenti.has(cheie)) return cacheAgenti.get(cheie);
  let u = await db.prepare("SELECT id FROM utilizatori WHERE LOWER(nume) = ?").get(cheie);
  if (!u) {
    const slug = cheie
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z ]/g, "")
      .trim()
      .replace(/\s+/g, ".");
    const email = `${slug}@cashmachine.ro`;
    const auth = require("../lib/auth");
    const { hash, salt } = auth.hashParola(require("crypto").randomBytes(9).toString("base64url"));
    try {
      const ins = await db
        .prepare("INSERT INTO utilizatori (nume, email, parola_hash, parola_salt, rol) VALUES (?, ?, ?, ?, 'vanzari') RETURNING id")
        .run(nume, email, hash, salt);
      u = { id: ins.lastInsertRowid };
    } catch (e) {
      // emailul generat există deja (alt nume, același slug) — refolosim contul
      const existent = await db.prepare("SELECT id FROM utilizatori WHERE email = ?").get(email);
      if (!existent) throw e;
      u = existent;
    }
  }
  cacheAgenti.set(cheie, u.id);
  return u.id;
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
  //
  // Exportul standard SmartBill ("Rapoarte → Facturi emise") are câteva
  // particularități de care ține cont codul de mai jos:
  //   - primele rânduri sunt titlu/notă/rând gol, header-ul real e abia pe
  //     rândul 4 → folosim gasesteRandHeader în loc de rows[0];
  //   - numărul documentului vine lipit de serie, într-o singură coloană
  //     ("Factura" = CSHMUPA0037) → îl despărțim în serie + număr;
  //   - ultimele rânduri sunt totaluri pe monedă, fără client și fără număr
  //     de document → le sărim tăcut, nu le raportăm ca erori;
  //   - facturile în EUR/USD au o coloană separată cu echivalentul în RON →
  //     stocăm sumele în RON (ca totalurile din ERP să fie comparabile) și
  //     păstrăm separat moneda și valoarea originală.
  //
  // Inserarea se face în loturi (batch INSERT), nu rând cu rând: un export
  // real are câteva mii de facturi, iar 4 interogări per rând ar însemna
  // >12.000 de dus-întorsuri către baza de date și un import de minute
  // întregi (cu risc de timeout). Așa rămân câteva zeci de interogări.
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

    const randHeader = gasesteRandHeader(rows, ALIASE);
    const header = randHeader === -1 ? [] : rows[randHeader].map(normalizeHeader);
    const idx = randHeader === -1 ? {} : mapColoane(header, ALIASE);
    if (randHeader === -1 || idx.client === -1 || (idx.serie === -1 && idx.numar === -1 && idx.serieNumar === -1)) {
      return send(
        ctx.res,
        200,
        paginaRezultat(
          "Import facturi — coloane nerecunoscute",
          {
            "Primele rânduri din fișier": rows
              .slice(0, 6)
              .map((r, i) => `${i + 1}: ${r.join(" | ")}`)
              .join("\n") || "(gol)",
          },
          ["Nu am putut identifica sigur coloanele de client și serie/număr document. Verifică denumirile coloanelor sau spune-mi exact ce coloane are fișierul."]
        )
      );
    }

    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");

    // ---- Pasul 1: citim tot fișierul în memorie și pregătim datele -------
    const erori = [];
    let sarite = 0;
    const inregistrari = [];
    const parteneriNoiDupaCheie = new Map();

    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;

      const numeClient = val(row, "client");
      const documentText = idx.serieNumar !== -1 ? val(row, "serieNumar") : "";
      const numarText = idx.numar !== -1 ? val(row, "numar") : "";

      // Rândurile de total de la finalul exportului nu au nici client, nici
      // document — le sărim fără să le numărăm ca erori.
      if (!numeClient && !documentText && !numarText) {
        sarite++;
        continue;
      }
      if (!numeClient) {
        erori.push(`Rând ${r + 1}: lipsește numele clientului/furnizorului.`);
        continue;
      }

      let serie, numar;
      if (idx.serie !== -1 && idx.numar !== -1) {
        serie = val(row, "serie") || "IMP";
        numar = parseInt(numarText.replace(/[^0-9]/g, ""), 10);
      } else {
        const m = documentText.match(/^([A-Za-z][A-Za-z\-_ ]*?)[\s\-\/]*([0-9]+)\s*$/);
        if (m) {
          serie = m[1].trim();
          numar = parseInt(m[2], 10);
        } else {
          // Documente de furnizor cu formate arbitrare ("FF 2026/00123",
          // "ABC-12/345"): seria = prefixul fără cifre (sau IMP), numărul =
          // ULTIMUL grup de cifre. Identitatea reală a documentului rămâne
          // oricum textul complet (document_extern), pe care se face dedupul.
          const prefix = (documentText.match(/^[^0-9]+/) || [""])[0].replace(/[\s\-\/]+$/, "").trim();
          const grupuri = documentText.match(/[0-9]+/g) || [];
          serie = prefix || "IMP";
          numar = parseInt(grupuri[grupuri.length - 1] || "", 10);
        }
      }
      if (!numar || isNaN(numar)) {
        erori.push(`Rând ${r + 1}: nu am găsit un număr de document valid (${documentText || numarText || "gol"}).`);
        continue;
      }

      const moneda = (val(row, "moneda") || "RON").toUpperCase();
      let faraTva = idx.faraTva !== -1 ? parseNumar(row[idx.faraTva]) : 0;
      let tva = idx.tva !== -1 ? parseNumar(row[idx.tva]) : 0;
      let total = idx.total !== -1 ? parseNumar(row[idx.total]) : faraTva + tva;
      const totalValuta = total;
      // Factură în valută: aducem totul în RON, folosind cursul implicit din
      // raport (raportul dintre coloana în RON și coloana în valută).
      const totalRon = idx.totalRon !== -1 ? parseNumar(row[idx.totalRon]) : 0;
      if (moneda !== "RON" && totalRon && total) {
        const curs = totalRon / total;
        faraTva *= curs;
        tva *= curs;
        total = totalRon;
      }

      inregistrari.push({
        rand: r + 1,
        serie,
        numar,
        numeClient,
        cui: val(row, "cui"),
        adresa: val(row, "adresa"),
        email: val(row, "email"),
        telefon: val(row, "telefon"),
        dataEmiterii: idx.dataEmiterii !== -1 ? parseData(row[idx.dataEmiterii]) : null,
        dataScadenta: idx.dataScadenta !== -1 ? parseData(row[idx.dataScadenta]) : null,
        faraTva,
        tva,
        total,
        moneda,
        totalValuta: moneda !== "RON" ? totalValuta : null,
        documentExtern: documentText || `${serie}${numar}`,
        indexSpv: val(row, "indexSpv"),
        observatiiFisier: val(row, "observatii"),
        agentDinObservatii: aratANumeDePersoana(val(row, "observatii")) ? val(row, "observatii") : null,
        status: statusDinText(val(row, "status")),
      });
    }

    if (!inregistrari.length) {
      return send(ctx.res, 200, paginaRezultat("Import facturi — niciun rând valid", { "Rânduri sărite (totaluri/goale)": sarite }, erori));
    }

    // ---- Pasul 2: parteneri (o singură citire + inserare în lot) ---------
    const tipDorit = directie === "achizitie" ? "furnizor" : "client";
    const dupaCui = new Map();
    const dupaNume = new Map();
    for (const p of await db.prepare("SELECT id, nume, cui, tip FROM parteneri").all()) {
      if (p.cui) dupaCui.set(String(p.cui).toLowerCase().trim(), p);
      dupaNume.set(String(p.nume).toLowerCase().trim(), p);
    }

    const deCreat = new Map();
    for (const inr of inregistrari) {
      const cheieCui = inr.cui.toLowerCase();
      const cheieNume = inr.numeClient.toLowerCase();
      const gasit = (cheieCui && dupaCui.get(cheieCui)) || dupaNume.get(cheieNume);
      if (gasit) {
        inr.partenerId = gasit.id;
        if (gasit.tip !== tipDorit && gasit.tip !== "ambele") gasit.tip = "ambele", (inr.deMarcatAmbele = gasit.id);
      } else {
        const cheie = cheieCui || cheieNume;
        if (!deCreat.has(cheie)) deCreat.set(cheie, inr);
        inr.cheiePartenerNou = cheie;
      }
    }

    const parteneriNoi = [...deCreat.values()];
    for (let i = 0; i < parteneriNoi.length; i += 200) {
      const lot = parteneriNoi.slice(i, i + 200);
      const placeholders = lot.map(() => "(?, ?, ?, ?, ?, ?, 'import_smartbill')").join(", ");
      const args = [];
      for (const p of lot) args.push(tipDorit, p.numeClient, p.cui || null, p.email || null, p.telefon || null, p.adresa || null);
      const inserate = await db
        .prepare(`INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa, sursa) VALUES ${placeholders} RETURNING id, nume, cui`)
        .all(...args);
      for (const nou of inserate) {
        if (nou.cui) dupaCui.set(String(nou.cui).toLowerCase().trim(), nou);
        dupaNume.set(String(nou.nume).toLowerCase().trim(), nou);
      }
    }
    for (const inr of inregistrari) {
      if (inr.partenerId) continue;
      const gasit = (inr.cui && dupaCui.get(inr.cui.toLowerCase())) || dupaNume.get(inr.numeClient.toLowerCase());
      if (gasit) inr.partenerId = gasit.id;
    }

    // --- agenți: numele din Observații → agentul clientului --------------
    // Rândurile vin cu factura cea mai nouă prima, deci prima mențiune
    // câștigă (= cea mai recentă factură decide agentul curent al clientului).
    const cacheAgenti = new Map();
    const agentPerPartener = new Map();
    let agentiAlocati = 0;
    if (directie === "vanzare") {
      for (const inr of inregistrari) {
        if (!inr.partenerId || !inr.agentDinObservatii) continue;
        if (agentPerPartener.has(inr.partenerId)) continue;
        agentPerPartener.set(inr.partenerId, await gasesteSauCreeazaAgent(inr.agentDinObservatii, cacheAgenti));
      }
      for (const [partenerId, agentId] of agentPerPartener) {
        await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(agentId, partenerId);
        agentiAlocati++;
      }
      // Clienții rămași fără agent merg la administrator.
      const admin = await db.prepare("SELECT id FROM utilizatori WHERE rol = 'admin' ORDER BY id LIMIT 1").get();
      if (admin) {
        await db.prepare("UPDATE parteneri SET agent_id = ? WHERE agent_id IS NULL AND tip IN ('client','ambele')").run(admin.id);
      }
    }

    const deMarcat = [...new Set(inregistrari.map((i) => i.deMarcatAmbele).filter(Boolean))];
    if (deMarcat.length) {
      await db.prepare(`UPDATE parteneri SET tip = 'ambele' WHERE id IN (${deMarcat.map(() => "?").join(",")})`).run(...deMarcat);
    }

    // ---- Pasul 3: sărim facturile deja existente ------------------------
    // Dedup pe DOUĂ chei: (serie, număr, partener) și (documentul original
    // normalizat, partener). A doua contează la facturile de furnizor, unde
    // "FF 2026/00123" și "FF2026-00123" sunt același document scris diferit —
    // normalizarea (majuscule, fără spații/punctuație) le face egale, deci
    // reimportul aceluiași fișier sau al unui export refăcut nu creează dubluri.
    const normDoc = (d) => String(d || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const existenteRanduri = await db.prepare("SELECT serie, numar, partener_id, document_extern FROM facturi WHERE directie = ?").all(directie);
    const existente = new Set();
    for (const f of existenteRanduri) {
      existente.add(`${f.serie}|${f.numar}|${f.partener_id}`);
      if (f.document_extern) existente.add(`DOC|${normDoc(f.document_extern)}|${f.partener_id}`);
    }
    const deInserat = [];
    for (const inr of inregistrari) {
      if (!inr.partenerId) {
        erori.push(`Rând ${inr.rand}: nu am putut crea/găsi partenerul „${inr.numeClient}”.`);
        continue;
      }
      const cheie = `${inr.serie}|${inr.numar}|${inr.partenerId}`;
      const cheieDoc = `DOC|${normDoc(inr.documentExtern)}|${inr.partenerId}`;
      if (existente.has(cheie) || existente.has(cheieDoc)) {
        sarite++;
        continue;
      }
      existente.add(cheie); // și în interiorul aceluiași fișier
      existente.add(cheieDoc);
      deInserat.push(inr);
    }

    // ---- Pasul 4: facturi + linii + plăți, în loturi ---------------------
    let create = 0;
    const azi = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < deInserat.length; i += 200) {
      const lot = deInserat.slice(i, i + 200);
      const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, 'smartbill', ?, ?, ?, ?)").join(", ");
      const args = [];
      for (const f of lot) {
        args.push(
          f.serie,
          f.numar,
          f.partenerId,
          directie,
          f.dataEmiterii || azi,
          f.dataScadenta || "",
          f.status,
          `Import SmartBill · document ${f.documentExtern}${f.observatiiFisier ? " · " + f.observatiiFisier : ""}`,
          f.moneda,
          f.totalValuta,
          f.documentExtern,
          f.indexSpv || null
        );
      }
      const inserate = await db
        .prepare(
          `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, observatii, sursa_import, moneda, total_valuta, document_extern, index_spv) VALUES ${ph} RETURNING id, serie, numar, partener_id`
        )
        .all(...args);

      const dupaCheie = new Map(inserate.map((f) => [`${f.serie}|${f.numar}|${f.partener_id}`, f.id]));
      const liniiArgs = [];
      const liniiPh = [];
      const platiArgs = [];
      const platiPh = [];
      for (const f of lot) {
        const facturaId = dupaCheie.get(`${f.serie}|${f.numar}|${f.partenerId}`);
        if (!facturaId) continue;
        // Cota de TVA se reconstituie din raportul TVA/net, NU rotunjită la
        // întreg: exportul e la nivel de document, iar o factură cu linii pe
        // cote diferite (19% + 5%, sau 19% + scutit) dă un raport intermediar
        // (ex. 18,73%). Rotunjit la întreg, totalul reconstituit n-ar mai da
        // exact suma din SmartBill. Păstrăm 4 zecimale → totalul iese la ban.
        const cotaTva = f.faraTva !== 0 ? Math.round((f.tva / f.faraTva) * 1000000) / 10000 : 0;
        const pretLinie = f.faraTva !== 0 ? f.faraTva : f.total;
        liniiPh.push("(?, ?, ?, ?, ?)");
        liniiArgs.push(facturaId, `Conform document ${f.documentExtern} (import SmartBill, fără detaliu pe produse)`, 1, pretLinie, cotaTva);
        if (f.status === "platita") {
          platiPh.push("(?, ?, ?, 'import', ?)");
          platiArgs.push(facturaId, f.total, f.dataEmiterii || "", "Plată reconstituită automat din statusul din SmartBill");
        }
        create++;
      }
      if (liniiPh.length) {
        await db.prepare(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES ${liniiPh.join(", ")}`).run(...liniiArgs);
      }
      if (platiPh.length) {
        await db.prepare(`INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES ${platiPh.join(", ")}`).run(...platiArgs);
      }
    }

    send(
      ctx.res,
      200,
      paginaRezultat(
        `Import facturi ${directie === "achizitie" ? "achiziție" : "vânzare"} — rezultat`,
        {
          "Facturi importate": create,
          "Sărite (deja existau sau rânduri de total)": sarite,
          "Parteneri noi creați": parteneriNoi.length,
          "Clienți alocați pe agenți (din Observații)": directie === "vanzare" ? agentiAlocati : "—",
          "Rânduri cu erori": erori.length,
        },
        erori
      )
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

    const randHeader = Math.max(0, gasesteRandHeader(rows, ALIASE));
    const header = rows[randHeader].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.client === -1) {
      return send(ctx.res, 200, paginaRezultat("Import parteneri — coloane nerecunoscute", { "Coloane găsite": rows[randHeader].join(" | ") }, ["Nu am găsit o coloană cu numele partenerului."]));
    }

    let create = 0,
      update = 0,
      err = 0;
    const erori = [];
    for (let r = randHeader + 1; r < rows.length; r++) {
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

    const randHeader = Math.max(0, gasesteRandHeader(rows, ALIASE));
    const header = rows[randHeader].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.produs === -1 && idx.cod === -1) {
      return send(ctx.res, 200, paginaRezultat("Import stoc — coloane nerecunoscute", { "Coloane găsite": rows[randHeader].join(" | ") }, ["Nu am găsit o coloană cu produsul."]));
    }

    let create = 0,
      err = 0,
      produseNoi = 0,
      depoziteNoi = 0;
    const erori = [];
    const cacheProduse = new Map();
    const cacheDepozite = new Map();

    for (let r = randHeader + 1; r < rows.length; r++) {
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

    const randHeader = Math.max(0, gasesteRandHeader(rows, ALIASE));
    const header = rows[randHeader].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    if (idx.produs === -1 && idx.cod === -1) {
      return send(ctx.res, 200, paginaRezultat("Import bonuri de consum — coloane nerecunoscute", { "Coloane găsite": rows[randHeader].join(" | ") }, ["Nu am găsit o coloană cu produsul."]));
    }

    let create = 0,
      err = 0;
    const erori = [];
    const cacheProduse = new Map();
    const cacheDepozite = new Map();

    for (let r = randHeader + 1; r < rows.length; r++) {
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

    const randHeader = Math.max(0, gasesteRandHeader(rows, ALIASE));
    const header = rows[randHeader].map(normalizeHeader);
    const idx = mapColoane(header, ALIASE);
    const idxFinit = idx.produsFinit !== -1 ? idx.produsFinit : idx.produs;
    const idxCantitate = idx.componentaCant !== -1 ? idx.componentaCant : idx.cantitate;
    if (idxFinit === -1 || idx.componenta === -1) {
      return send(
        ctx.res,
        200,
        paginaRezultat("Import rețete — coloane nerecunoscute", { "Coloane găsite": rows[randHeader].join(" | ") }, [
          "Nu am găsit clar coloanele de produs finit și componentă. Fișierul trebuie să aibă o coloană separată pentru fiecare (ex: „Produs finit” și „Componentă”).",
        ])
      );
    }

    let create = 0,
      err = 0;
    const erori = [];
    const cacheProduse = new Map();

    for (let r = randHeader + 1; r < rows.length; r++) {
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
