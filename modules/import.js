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
const grup = require("../lib/grup");
const { xlsxDisponibil, normalizeHeader, gasesteColoana, gasesteRandHeader, parseFisier, parseNumar, parseData } = require("../lib/import-utils");

const ALIASE = {
  serie: ["serie", "seria"],
  numar: ["numar", "nr", "numardocument", "nrdocument", "numarfactura"],
  serieNumar: ["factura", "documentfurnizor", "serieinumarul", "seriasinumarul", "seriasinumaruldocumentuluiemis", "document", "numardocumentemis", "numefactura", "nrfactura", "documentemis"],
  client: ["client", "partener", "furnizor", "denumireclient", "denumirepartener", "denumire", "denumirefurnizor", "nume", "numeclient", "numefurnizor", "numepartener"],
  cui: ["cui", "cif", "codfiscal", "cuicnp", "cifcui"],
  email: ["email", "emailclient", "adresaemail"],
  telefon: ["telefon", "tel", "nrtelefon"],
  adresa: ["adresa", "adresaclient", "adresasediu"],
  dataEmiterii: ["dataemiterii", "data", "datadoc", "dataemitere", "dataemis", "datadocument"],
  dataScadenta: ["datascadentei", "datascadenta", "scadenta", "termendeplata"],
  faraTva: ["valoarefaratva", "subtotal", "valoarenet", "fatva", "netfaratva", "valoarenetalei", "valoarenetlei"],
  tva: ["valoaretva", "tva", "sumatva", "tvalei"],
  total: ["total", "valoaretotala", "totalcutva", "valoare", "totallei", "valoaretotal"],
  totalRon: ["valoaretotalaron", "valoaretotalalei", "totalron", "totallei", "valoareron"],
  moneda: ["moneda", "valuta"],
  observatii: ["observatii", "mentiuni", "note"],
  categoria: ["categoria", "categorie"],
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
  dataIncasarii: ["dataincasarii", "dataincasare", "dataplatii", "dataplata", "dataincasari"],
  incasare: ["incasare", "nrincasare", "numarincasare", "chitanta"],
  angajat: ["nume", "numesiprenume", "numeprenume", "angajat", "salariat", "numeangajat", "numesalariat"],
  salariuBrut: ["salariubrut", "brut", "venitbrut", "salariulbrut", "totalbrut", "brutrealizat", "salarbrut"],
  luna: ["luna", "perioada", "lunaan"],
  card: ["card", "numarcard", "nrcard", "cardnumber", "rezerva", "cardrezerva"],
  suma: ["suma", "valoare", "total", "valoarelei", "sumalei", "amount"],
  dataTranz: ["data", "datatranzactie", "datatranzactiei", "transactiondate"],
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

// Raportul de documente furnizor din SmartBill NU are coloana de echivalent
// în RON pentru facturile în valută (spre deosebire de raportul de facturi
// emise). Ca totalurile ERP să rămână comparabile, convertim cu un curs
// ESTIMATIV, marcat explicit pe factură în Observații — suma exactă în
// valută rămâne salvată separat (total_valuta + moneda), deci nimic nu se
// pierde. Contabilitatea de drept rămâne în SmartBill Conta, cu cursul BNR
// al fiecărei zile.
const CURS_ESTIMATIV = { EUR: 5.03, USD: 4.33, GBP: 5.9, SEK: 0.45, HUF: 0.0128, CHF: 5.4, PLN: 1.18, TRY: 0.11 };

// CUI-urile "de umplutură" din exporturi ("-", ".", "0", "n/a") NU sunt
// identitate: dacă le-am folosi la potrivire, toți furnizorii externi cu
// CIF "-" s-ar lipi de același partener (bug real, prins la testare —
// facturile Uyumplast ajunseseră pe alt furnizor). Un CUI e valid doar dacă
// are cel puțin 4 caractere alfanumerice și măcar o cifră.
function cuiValid(cui) {
  const c = String(cui || "").trim();
  const alfanumeric = c.replace(/[^0-9A-Za-z]/g, "");
  return /[0-9]/.test(alfanumeric) && alfanumeric.length >= 4 ? c : "";
}

function statusDinText(text) {
  const t = (text || "").toLowerCase();
  if (/anulat|stornat/.test(t)) return "anulata";
  // "Salvat/Salvata", "Info", "In prelucrare" din raportul de documente
  // furnizor NU înseamnă neplătit — înseamnă că SmartBill doar a înregistrat
  // documentul, fără să urmărească plata. Dacă le-am trata ca datorii, ar
  // apărea 36 de milioane "de plătit" din 2022 — facturi achitate demult.
  // Le dăm un status propriu, iar rapoartele de solduri le exclud.
  if (/^\s*(salvat|salvata|salvată|info|in prelucrare|în prelucrare)\s*$/.test(t)) return "necunoscut";
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
  cui = (typeof cuiValid === "function" ? cuiValid(cui) : cui);
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
    const firmeGrup = await grup.listaFirmeOperationale();
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
        <label class="field"><span>Firma care a emis / primit documentele</span>
          <select name="firma_id">
            ${firmeGrup.map((fr) => `<option value="${fr.id}"${fr.implicita ? " selected" : ""}>${esc(fr.nume)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Tip document</span>
          <select name="directie">
            <option value="vanzare">Facturi emise (vânzări către clienți)</option>
            <option value="achizitie">Facturi de achiziție (de la furnizori)</option>
          </select>
        </label>
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă facturi</button>
      </form>

      <h2>1b. Încasări (plățile reale, cu data la care au intrat banii)</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        SmartBill Cloud → Documente emise → <strong>Încasări</strong> → alege intervalul → Exportă.
        Ăsta e importul care contează pentru comisioane: până acum plățile erau reconstituite din statusul
        facturii (cu data emiterii), nu din încasarea reală. O încasare care acoperă mai multe facturi se
        împarte automat între ele, proporțional cu soldul. Reimportul e sigur — plățile identice sunt sărite.
      </p>
      <form method="post" action="/import/incasari" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xls / .xlsx / .csv)</span><input type="file" name="fisier" required></label>
        <button type="submit" class="btn">Importă încasările</button>
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

      <h2>6. Registrul de comenzi (modelul oficial) — recomandat</h2>
      <p style="font-size:13px;color:var(--text-muted)">„Registru Comenzi CASH MACHINE": Nr. comandă (20260803-001), client, reprezentant, produs, caracteristici, cantitate+UM, ambalare, date plasare/livrare, stare, DoC, fișă tehnică, facturat, rețetă. Dedup pe numărul de comandă — reimportul e sigur.</p>
      <form method="post" action="/import/registru-comenzi" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă registrul de comenzi</button>
      </form>

      <h2>6b. Comenzi în lucru (Excelul vechi, nestructurat)</h2>
      <p style="font-size:13px;color:var(--text-muted)">Fișierul „Comenzi_in_lucru" cu coloanele: număr, inițiator, tip produs, dată inițiere, client, cantitate, data solicitată de client, data propusă de producție, start producție, status, dată finalizare, info, rețetă. Statusurile (done/facturat/canceled) sunt recunoscute oriunde ar fi pe rând, iar datele în ambele formate (19.09.2025 și 09/23/2025). Dublurile sunt sărite automat.</p>
      <form method="post" action="/import/comenzi-productie" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xlsx sau .csv)</span><input type="file" name="fisier" accept=".xlsx,.xls,.csv" required></label>
        <button type="submit" class="btn">Importă comenzile de producție</button>
      </form>

      <h2>7. Sincronizare stoc curent (live, prin API-ul SmartBill)</h2>
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

      <h2>7b. Leagă liniile de factură de produse (ca să se poată calcula marja)</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Facturile importate din SmartBill au denumirea produsului ca text liber. Fără legătura cu
        nomenclatorul, ERP-ul nu știe costul mărfii și marja iese 100% — fals. Rutina potrivește
        denumirile cu produsele existente și îți arată ce n-a putut lega.
      </p>
      <form method="post" action="/import/leaga-produse">
        <button type="submit" class="btn">Leagă liniile de produse</button>
      </form>

      <h2>7c. Preia costul produselor din evaluarea stocului</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Fără preț de achiziție pe produs, marja iese tot 100%. Raportul „Stoc la zi" adus prin punte are
        valoarea stocului, iar valoare împărțită la cantitate e chiar costul unitar cu care SmartBill își
        evaluează marfa. Rutina îl pune ca preț de achiziție pe produsele care n-au unul — nu atinge
        prețurile puse de om și nu inventează cost pentru produsele fără stoc.
      </p>
      <form method="post" action="/import/cost-din-stoc">
        <button type="submit" class="btn">Preia costul din stoc</button>
      </form>

      <h2>7d. Calculează costul produselor fabricate, din rețetă</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Un produs pe care îl facem noi n-are preț de achiziție — costul lui e suma componentelor din rețeta
        adusă din rapoartele de producție. Rulează pasul ăsta <strong>după</strong> „preia costul din stoc",
        ca materiile prime să aibă deja preț. Îți spune câte rețete au ieșit acoperite integral și câte doar
        parțial, ca să știi unde marja arată mai bine decât e.
      </p>
      <form method="post" action="/import/cost-din-reteta">
        <button type="submit" class="btn">Calculează costul din rețetă</button>
      </form>

      <h2>8. State de salarii (costul real al oamenilor)</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Statul de plată lunar — de aici vine salariul brut din „cost company". Fișierul poate avea luna
        într-o coloană sau doar în nume; dacă nu, alege-o mai jos. Oamenii se potrivesc după nume cu conturile din Utilizatori.
      </p>
      <form method="post" action="/import/state-salarii" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Luna (dacă nu e în fișier)</span><input type="month" name="luna"></label>
        <label class="field"><span>Fișier (.xls / .xlsx / .csv)</span><input type="file" name="fisier" required></label>
        <button type="submit" class="btn">Importă statul de plată</button>
      </form>

      <h2>9. Alimentări carburant (OMV)</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Extrasul cardurilor OMV. Fiecare alimentare are numărul cardului; cardul se leagă de om în
        Utilizatori → „Card carburant". Sumele se adună pe lună și intră automat în costul lunii.
      </p>
      <form method="post" action="/import/carburant" enctype="multipart/form-data" class="form" style="max-width:520px">
        <label class="field"><span>Fișier (.xls / .xlsx / .csv)</span><input type="file" name="fisier" required></label>
        <button type="submit" class="btn">Importă alimentările</button>
      </form>

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
    // Firma emitentă: importurile din SmartBill se fac per firmă (Cash Machine
    // sau Warehouse All), iar rapoartele de grup elimină apoi facturile dintre ele.
    const firmaId = parseInt(ctx.body.firma_id, 10) || (await grup.firmaImplicita()).id;
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
      // "Fact GT2620629", "Bon fiscal 27", "Proforma 12" — tipul documentului
      // nu e serie; îl scoatem din față (rămâne în document_extern complet).
      const documentCurat = documentText.replace(/^(factura|fact|bon\s*fiscal|bon|proforma|aviz)\s+/i, "");
      if (idx.serie !== -1 && idx.numar !== -1) {
        serie = val(row, "serie") || "IMP";
        numar = parseInt(numarText.replace(/[^0-9]/g, ""), 10);
      } else {
        const m = documentCurat.match(/^([A-Za-z][A-Za-z\-_ ]*?)[\s\-\/]*([0-9]+)\s*$/);
        if (m) {
          serie = m[1].trim();
          numar = parseInt(m[2], 10);
        } else {
          // Documente de furnizor cu formate arbitrare ("FF 2026/00123",
          // "ABC-12/345"): seria = prefixul fără cifre (sau IMP), numărul =
          // ULTIMUL grup de cifre. Identitatea reală a documentului rămâne
          // oricum textul complet (document_extern), pe care se face dedupul.
          const prefix = (documentCurat.match(/^[^0-9]+/) || [""])[0].replace(/[\s\-\/]+$/, "").trim();
          const grupuri = documentCurat.match(/[0-9]+/g) || [];
          serie = prefix || "IMP";
          numar = parseInt(grupuri[grupuri.length - 1] || "", 10);
        }
      }
      if (!numar || isNaN(numar)) {
        // Documente fără niciun număr (unii furnizori externi emit așa).
        // Le dăm un număr derivat din data documentului ca să nu piardă
        // factura — identitatea rămâne documentul + furnizorul + data.
        const dataFallback = idx.dataEmiterii !== -1 ? parseData(row[idx.dataEmiterii]) : null;
        if (directie === "achizitie" && dataFallback) {
          serie = "FARA-NR";
          numar = Number(dataFallback.replace(/-/g, ""));
        } else {
          erori.push(`Rând ${r + 1}: nu am găsit un număr de document valid (${documentText || numarText || "gol"}).`);
          continue;
        }
      }
      // Unele documente de furnizor au numere uriașe (coduri de 15-20 de
      // cifre) care depășesc INTEGER-ul bazei de date. Păstrăm ultimele 9
      // cifre — identitatea reală a documentului e oricum textul complet
      // (document_extern), pe care se face și dedupul.
      if (numar > 2000000000) numar = Number(String(numar).slice(-9));

      const moneda = (val(row, "moneda") || "RON").toUpperCase();
      let faraTva = idx.faraTva !== -1 ? parseNumar(row[idx.faraTva]) : 0;
      let tva = idx.tva !== -1 ? parseNumar(row[idx.tva]) : 0;
      let total = idx.total !== -1 ? parseNumar(row[idx.total]) : faraTva + tva;
      const totalValuta = total;
      // Factură în valută: aducem totul în RON, folosind cursul implicit din
      // raport (raportul dintre coloana în RON și coloana în valută).
      const totalRon = idx.totalRon !== -1 ? parseNumar(row[idx.totalRon]) : 0;
      let notaCurs = "";
      if (moneda !== "RON" && totalRon && total) {
        const curs = totalRon / total;
        faraTva *= curs;
        tva *= curs;
        total = totalRon;
      } else if (moneda !== "RON" && total && CURS_ESTIMATIV[moneda]) {
        // raportul nu dă echivalentul RON — folosim curs estimativ, marcat
        const curs = CURS_ESTIMATIV[moneda];
        faraTva *= curs;
        tva *= curs;
        total *= curs;
        notaCurs = ` · convertit cu curs estimativ ${curs} RON/${moneda}`;
      }
      const categoria = val(row, "categoria");

      inregistrari.push({
        rand: r + 1,
        serie,
        numar,
        numeClient,
        cui: cuiValid(val(row, "cui")),
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
        observatiiFisier: [val(row, "observatii"), categoria ? `Categoria: ${categoria}` : "", notaCurs.trim()].filter(Boolean).join(" · "),
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
    // La achiziții, cheile de dedup includ și DATA: numerele de bon fiscal și
    // numerotarea furnizorilor mici se RECICLEAZĂ (același "Bon fiscal 27" de
    // la METROREX apare în luni diferite = documente diferite, nu dubluri).
    // La vânzări (numerotarea noastră, unică) data nu intră în cheie.
    const cuData = directie === "achizitie";
    const existenteRanduri = await db
      .prepare("SELECT serie, numar, partener_id, document_extern, data_emiterii FROM facturi WHERE directie = ? AND firma_id = ?")
      .all(directie, firmaId);
    const existente = new Set();
    const cheiPentru = (serie, numar, partenerId, docExtern, data) => {
      const sufix = cuData ? `|${String(data || "").slice(0, 10)}` : "";
      return [`${serie}|${numar}|${partenerId}${sufix}`, `DOC|${normDoc(docExtern)}|${partenerId}${sufix}`];
    };
    for (const f of existenteRanduri) {
      const [c1, c2] = cheiPentru(f.serie, f.numar, f.partener_id, f.document_extern, f.data_emiterii);
      existente.add(c1);
      if (f.document_extern) existente.add(c2);
    }
    const deInserat = [];
    for (const inr of inregistrari) {
      if (!inr.partenerId) {
        erori.push(`Rând ${inr.rand}: nu am putut crea/găsi partenerul „${inr.numeClient}”.`);
        continue;
      }
      const [cheie, cheieDoc] = cheiPentru(inr.serie, inr.numar, inr.partenerId, inr.documentExtern, inr.dataEmiterii);
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
      const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, 'smartbill', ?, ?, ?, ?, ?)").join(", ");
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
          f.indexSpv || null,
          firmaId
        );
      }
      const inserate = await db
        .prepare(
          `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, observatii, sursa_import, moneda, total_valuta, document_extern, index_spv, firma_id) VALUES ${ph} RETURNING id, serie, numar, partener_id`
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

    const marcaje = await grup.marcheazaIntercompany();

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
          "Facturi în interiorul grupului (eliminate din rapoarte)": marcaje.facturiMarcate,
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
  // ---- 8. Încasări (plăți pe facturi) -----------------------------------
  //
  // Până acum, plățile din ERP erau RECONSTITUITE din statusul facturii din
  // SmartBill ("Încasată" → o plată egală cu totalul, datată la emitere).
  // E o aproximare care strică exact lucrul care contează la comisioane:
  // data la care au intrat banii. Raportul "Încasări" din SmartBill Cloud
  // dă plata reală — factură, dată, sumă — și asta importăm aici.
  //
  // O încasare poate acoperi mai multe facturi ("CSHM2750, CSHM2752") —
  // atunci suma se împarte între ele proporțional cu soldul fiecăreia.
  // Duplicatele se evită prin cheia (factură, dată, sumă).
  router.post("/import/incasari", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import încasări", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import încasări", { Eroare: e.message }, []));
    }
    const randHeader = gasesteRandHeader(rows, ALIASE);
    const header = randHeader === -1 ? [] : rows[randHeader].map(normalizeHeader);
    const idx = randHeader === -1 ? {} : mapColoane(header, ALIASE);
    const colFactura = idx.serieNumar !== -1 ? idx.serieNumar : idx.numar;
    if (randHeader === -1 || colFactura === -1 || idx.dataIncasarii === -1) {
      return send(
        ctx.res,
        200,
        paginaRezultat(
          "Import încasări — coloane nerecunoscute",
          { "Primele rânduri": rows.slice(0, 6).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n") || "(gol)" },
          ["Am nevoie măcar de coloana cu factura și cea cu data încasării."]
        )
      );
    }
    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");

    // Indexăm facturile de vânzare după serie+număr, ca să potrivim rapid.
    const facturi = await db
      .prepare("SELECT id, serie, numar FROM facturi WHERE directie = 'vanzare' AND status NOT IN ('anulata','ciorna')")
      .all();
    const dupaCheie = new Map();
    for (const f of facturi) {
      const cheie = `${String(f.serie || "").toUpperCase()}${String(f.numar || "")}`.replace(/[^A-Z0-9]/g, "");
      if (!dupaCheie.has(cheie)) dupaCheie.set(cheie, []);
      dupaCheie.get(cheie).push(f.id);
    }
    // Plățile deja existente, ca să nu dublăm la reimport.
    const existente = new Set(
      (await db.prepare("SELECT factura_id, data, suma FROM plati").all()).map(
        (p) => `${p.factura_id}|${String(p.data).slice(0, 10)}|${Number(p.suma).toFixed(2)}`
      )
    );
    // Soldul curent al fiecărei facturi — pentru împărțirea unei încasări
    // care acoperă mai multe facturi.
    const solduri = new Map(
      (
        await db
          .prepare(
            `SELECT f.id, COALESCE(l.total,0) - COALESCE(pl.platit,0) AS sold
               FROM facturi f
               LEFT JOIN (SELECT factura_id, SUM(cantitate*pret_unitar*(1+COALESCE(cota_tva,0)/100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
               LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id) pl ON pl.factura_id = f.id
              WHERE f.directie='vanzare'`
          )
          .all()
      ).map((r) => [r.id, Number(r.sold) || 0])
    );

    const erori = [];
    let adaugate = 0, duplicate = 0, faraFactura = 0, randuri = 0;
    const deInserat = [];

    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const brutFactura = String(row[colFactura] ?? "").trim();
      const dataBruta = val(row, "dataIncasarii");
      if (!brutFactura || !dataBruta) continue;
      const data = parseData(dataBruta);
      if (!data) continue;
      const suma = parseNumar(val(row, "totalRon") || val(row, "total"));
      if (!(suma > 0)) continue;
      randuri++;

      // O încasare poate lista mai multe facturi, separate prin virgulă.
      const bucati = brutFactura.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
      const tinte = [];
      for (const b of bucati) {
        const cheie = b.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const gasite = dupaCheie.get(cheie);
        if (gasite && gasite.length) tinte.push(gasite[0]);
      }
      if (!tinte.length) { faraFactura++; if (erori.length < 60) erori.push(`Rândul ${r + 1}: nu găsesc factura „${brutFactura}" în ERP.`); continue; }

      // împărțim suma proporțional cu soldul (sau egal, dacă n-avem solduri)
      const ponderi = tinte.map((id) => Math.max(0.0001, solduri.get(id) || 0));
      const totalPondere = ponderi.reduce((a, b) => a + b, 0);
      tinte.forEach((id, i) => {
        const cota = totalPondere > 0 ? (suma * ponderi[i]) / totalPondere : suma / tinte.length;
        const rotunjit = Math.round(cota * 100) / 100;
        const cheieDup = `${id}|${data}|${rotunjit.toFixed(2)}`;
        if (existente.has(cheieDup)) { duplicate++; return; }
        existente.add(cheieDup);
        deInserat.push([id, rotunjit, data]);
        adaugate++;
      });
    }

    // inserare în loturi
    const LOT = 200;
    for (let i = 0; i < deInserat.length; i += LOT) {
      const lot = deInserat.slice(i, i + LOT);
      const ph = lot.map(() => "(?, ?, ?, 'import smartbill', 'Încasare importată din raportul SmartBill')").join(", ");
      const args = [];
      for (const l of lot) args.push(l[0], l[1], l[2]);
      await db.prepare(`INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES ${ph}`).run(...args);
    }

    // Statusul facturilor se recalculează din plăți: achitat integral,
    // parțial, sau neîncasat — ca listele de creanțe să fie corecte.
    await db.exec(`
      UPDATE facturi SET status = 'platita'
       WHERE directie = 'vanzare' AND status NOT IN ('anulata')
         AND id IN (
           SELECT f.id FROM facturi f
           JOIN (SELECT factura_id, SUM(suma) s FROM plati GROUP BY factura_id) p ON p.factura_id = f.id
           JOIN (SELECT factura_id, SUM(cantitate*pret_unitar*(1+COALESCE(cota_tva,0)/100.0)) t FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
           WHERE p.s >= l.t - 0.5)
    `);
    await db.exec(`
      UPDATE facturi SET status = 'platita_partial'
       WHERE directie = 'vanzare' AND status NOT IN ('anulata')
         AND id IN (
           SELECT f.id FROM facturi f
           JOIN (SELECT factura_id, SUM(suma) s FROM plati GROUP BY factura_id) p ON p.factura_id = f.id
           JOIN (SELECT factura_id, SUM(cantitate*pret_unitar*(1+COALESCE(cota_tva,0)/100.0)) t FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
           WHERE p.s > 0.5 AND p.s < l.t - 0.5)
    `);

    send(
      ctx.res,
      200,
      paginaRezultat(
        "Import încasări",
        {
          "Rânduri citite": randuri,
          "Plăți adăugate": adaugate,
          "Duplicate sărite": duplicate,
          "Fără factură în ERP": faraFactura,
        },
        erori
      )
    );
  });

  // ---- 9. State de salarii (costul real al oamenilor) --------------------
  //
  // Costul lunar al unui om NU se introduce de mână: vine din statul de plată
  // lunar (salariul brut realizat), din factura mașinii și din alimentările
  // OMV pe cardul lui. Importul de aici aduce partea de salariu.
  //
  // Fișierul poate avea luna într-o coloană sau doar în numele fișierului
  // ("Stat de plata 07-2026.xls") — încercăm ambele.
  router.post("/import/state-salarii", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import state de salarii", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import state de salarii", { Eroare: e.message }, []));
    }
    const randHeader = gasesteRandHeader(rows, ALIASE);
    const header = randHeader === -1 ? [] : rows[randHeader].map(normalizeHeader);
    const idx = randHeader === -1 ? {} : mapColoane(header, ALIASE);
    const colNume = idx.angajat !== -1 ? idx.angajat : idx.client;
    if (randHeader === -1 || colNume === -1 || idx.salariuBrut === -1) {
      return send(
        ctx.res,
        200,
        paginaRezultat(
          "Import state de salarii — coloane nerecunoscute",
          { "Primele rânduri": rows.slice(0, 8).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n") || "(gol)" },
          ["Am nevoie de o coloană cu numele angajatului și una cu salariul brut."]
        )
      );
    }
    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");

    // luna: din coloană, din formularul de import, sau din numele fișierului
    const lunaDinNume = (() => {
      const m = String(file.filename || "").match(/(\d{4})[-_. ]?(\d{2})|(\d{2})[-_. ](\d{4})/);
      if (!m) return null;
      if (m[1]) return `${m[1]}-${m[2]}`;
      return `${m[4]}-${m[3]}`;
    })();
    const lunaFormular = /^\d{4}-\d{2}$/.test(String(ctx.body.luna || "")) ? String(ctx.body.luna) : null;

    const utilizatori = await db.prepare("SELECT id, nume, cost_masina_lunar, masina_detalii FROM utilizatori WHERE activ = 1").all();
    const normNume = (v) =>
      String(v || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z ]/g, "")
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ");

    const erori = [];
    let actualizate = 0, sarite = 0, faraOm = 0;
    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const nume = String(row[colNume] ?? "").trim();
      const brut = parseNumar(val(row, "salariuBrut"));
      if (!nume || !(brut > 0)) { sarite++; continue; }
      const luna = (() => {
        const dinColoana = val(row, "luna");
        if (/^\d{4}-\d{2}/.test(dinColoana)) return dinColoana.slice(0, 7);
        const d = parseData(dinColoana);
        if (d) return d.slice(0, 7);
        return lunaFormular || lunaDinNume;
      })();
      if (!luna) { erori.push(`Rândul ${r + 1}: nu știu pentru ce lună e „${nume}". Alege luna în formular.`); sarite++; continue; }

      const n = normNume(nume);
      const u = utilizatori.find((x) => normNume(x.nume) === n) || utilizatori.find((x) => normNume(x.nume).split(" ").every((p) => n.includes(p)));
      if (!u) { faraOm++; if (erori.length < 40) erori.push(`Rândul ${r + 1}: „${nume}" nu are cont în ERP — creează-l la Utilizatori, apoi reimportă.`); continue; }

      const deLa = `${luna}-01`;
      const existent = await db.prepare("SELECT id, cost_carburant, alte_costuri FROM costuri_personal WHERE utilizator_id = ? AND valabil_de_la = ?").get(u.id, deLa);
      if (existent) {
        await db.prepare("UPDATE costuri_personal SET salariu_brut = ?, cost_masina = ?, masina_detalii = ? WHERE id = ?").run(brut, Number(u.cost_masina_lunar) || 0, u.masina_detalii || null, existent.id);
      } else {
        await db
          .prepare("INSERT INTO costuri_personal (utilizator_id, valabil_de_la, salariu_brut, cost_masina, masina_detalii, cost_carburant, alte_costuri, observatii) VALUES (?, ?, ?, ?, ?, 0, 0, ?)")
          .run(u.id, deLa, brut, Number(u.cost_masina_lunar) || 0, u.masina_detalii || null, "din statul de plată");
      }
      actualizate++;
    }

    send(
      ctx.res,
      200,
      paginaRezultat(
        "Import state de salarii",
        { "Luni/oameni actualizați": actualizate, "Rânduri sărite": sarite, "Fără cont în ERP": faraOm, "Luna din fișier": lunaFormular || lunaDinNume || "(din coloană)" },
        erori
      )
    );
  });

  // ---- 10. Alimentări carburant (OMV) ------------------------------------
  // Extrasul de card OMV: fiecare alimentare are numărul cardului („rezerva").
  // Cardul e legat de om în Utilizatori → card carburant. Sumele se adună pe
  // lună și intră în costul lunii respective.
  router.post("/import/carburant", async (ctx) => {
    const file = preiaFisier(ctx);
    if (!file) return send(ctx.res, 200, paginaRezultat("Import carburant", { Eroare: "Nu ai selectat niciun fișier." }, []));
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, paginaRezultat("Import carburant", { Eroare: e.message }, []));
    }
    const randHeader = gasesteRandHeader(rows, ALIASE);
    const header = randHeader === -1 ? [] : rows[randHeader].map(normalizeHeader);
    const idx = randHeader === -1 ? {} : mapColoane(header, ALIASE);
    if (randHeader === -1 || idx.card === -1 || idx.suma === -1) {
      return send(
        ctx.res,
        200,
        paginaRezultat(
          "Import carburant — coloane nerecunoscute",
          { "Primele rânduri": rows.slice(0, 8).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n") || "(gol)" },
          ["Am nevoie de o coloană cu numărul cardului și una cu suma."]
        )
      );
    }
    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");

    const utilizatori = await db.prepare("SELECT id, nume, card_carburant, cost_masina_lunar, masina_detalii FROM utilizatori WHERE activ = 1 AND card_carburant IS NOT NULL AND card_carburant <> ''").all();
    const dupaCard = new Map();
    for (const u of utilizatori) {
      for (const c of String(u.card_carburant).split(/[,;\s]+/).filter(Boolean)) dupaCard.set(c.replace(/\D/g, "").slice(-6), u);
    }

    const peOmSiLuna = new Map();
    const erori = [];
    let randuri = 0, faraCard = 0;
    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const card = val(row, "card").replace(/\D/g, "").slice(-6);
      const suma = parseNumar(val(row, "suma"));
      const data = parseData(val(row, "dataTranz")) || parseData(val(row, "dataEmiterii"));
      if (!card || !(suma > 0) || !data) continue;
      randuri++;
      const u = dupaCard.get(card);
      if (!u) { faraCard++; continue; }
      const cheie = `${u.id}|${data.slice(0, 7)}`;
      peOmSiLuna.set(cheie, (peOmSiLuna.get(cheie) || 0) + suma);
    }

    let scrise = 0;
    for (const [cheie, suma] of peOmSiLuna.entries()) {
      const [uid, luna] = cheie.split("|");
      const u = utilizatori.find((x) => String(x.id) === uid);
      const deLa = `${luna}-01`;
      const existent = await db.prepare("SELECT id FROM costuri_personal WHERE utilizator_id = ? AND valabil_de_la = ?").get(uid, deLa);
      if (existent) {
        await db.prepare("UPDATE costuri_personal SET cost_carburant = ? WHERE id = ?").run(Math.round(suma * 100) / 100, existent.id);
      } else {
        await db
          .prepare("INSERT INTO costuri_personal (utilizator_id, valabil_de_la, salariu_brut, cost_masina, masina_detalii, cost_carburant, alte_costuri, observatii) VALUES (?, ?, 0, ?, ?, ?, 0, ?)")
          .run(uid, deLa, Number(u && u.cost_masina_lunar) || 0, (u && u.masina_detalii) || null, Math.round(suma * 100) / 100, "alimentări OMV");
      }
      scrise++;
    }
    if (faraCard) erori.push(`${faraCard} alimentări au un card care nu e legat de niciun om. Leagă cardul în Utilizatori → editează → „Card carburant".`);

    send(
      ctx.res,
      200,
      paginaRezultat("Import alimentări carburant", { "Alimentări citite": randuri, "Luni actualizate": scrise, "Fără card legat": faraCard }, erori)
    );
  });

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
