"use strict";
// Culegerea din emailuri — serviciul care rulează noaptea, la 02:00.
//
// Ce face: se uită prin mesajele intrate în ultimele zile și scoate din ele
// două lucruri pe care altfel le-ar scrie cineva de mână, o dată la trei
// săptămâni, pe jumătate:
//
//   1. OAMENII din semnături. Cine ne-a scris de la un partener, cum îl
//      cheamă, ce funcție are, ce telefon. Intră în Contacte, legat de firma
//      lui. Marketingul are de-atunci cui să trimită; agentul are pe cine să
//      sune fără să caute prin inbox.
//   2. OFERTELE primite de la furnizori — partea a doua, vine separat.
//
// Trei reguli care stau la baza a tot ce e mai jos, fiindcă un contact greșit
// e mai rău decât unul lipsă:
//
//   - NU SE SUPRASCRIE NIMIC PUS DE UN OM. Dacă cineva a scris funcția sau
//     telefonul cu mâna lui, serviciul trece mai departe. Completează doar
//     golurile.
//   - CE NU E SIGUR NU INTRĂ. Un nume care seamănă a firmă, un telefon care
//     nu arată a telefon românesc, un mesaj de la gmail.com — toate se sar.
//     Mai bine zece contacte lipsă decât unul pus la firma greșită.
//   - TOT CE FACE SE VEDE. Fiecare rulare se scrie în istoric, cu ce a găsit
//     și ce a sărit, iar fiecare contact născut aici poartă sursa „semnătură".
const db = require("../lib/db");
const { pareFirma, normNume } = require("./marketing");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const ORA_RULARE = 2; // 02:00, cum a cerut Vali
const ZILE_INAPOI = 7; // la fiecare rulare se recitesc ultimele șapte zile
const MAX_MESAJE = 2000;

const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const azi = () => new Date().toISOString().slice(0, 10);

// Domeniile de unde vin oameni, dar nu firme: semnătura lor nu spune nimic
// despre cine e partenerul.
const DOMENII_PUBLICE = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ro", "hotmail.com",
  "outlook.com", "live.com", "icloud.com", "protonmail.com", "aol.com", "msn.com",
]);

// ---- citirea semnăturii -----------------------------------------------------

// Unde începe semnătura. Trei încercări, de la cea mai sigură la cea mai
// grosolană — ultima nu greșește prea rău, fiindcă tot ce se scoate după aceea
// e verificat bucată cu bucată.
// ATENȚIE la marginile de cuvânt: în JavaScript, „\b" se uită după litere
// [A-Za-z0-9_], iar ă â î ș ț NU sunt printre ele. Deci /stim[ăa]\b/ nu
// prinde „stimă," — între „ă" și „," nu există nicio margine. Bug-ul ăsta a
// trecut de citit și l-a prins doar testul: ar fi stricat tăcut fiecare
// semnătură românească din firmă, și nimeni n-ar fi știut de ce contactele
// n-au funcții. De-aia marginile se scriu de mână, cu diacriticele în ele.
const LITERA = "a-zA-Z0-9_ăâîșțĂÂÎȘȚ";
const INCHEIERE = new RegExp(
  `^\\s*(cu (stim[ăa]|respect|drag|bine)|numai bine|toate cele bune|mult succes|o zi bun[ăa]|mul[țt]umesc|v[ăa] mul[țt]umesc|best regards|kind regards|regards|sincerely|thanks|thank you|br|vr)(?![${LITERA}])`,
  "i"
);

function bloculSemnaturii(corp) {
  const linii = String(corp || "").replace(/\r/g, "").split("\n");
  const deUnde = Math.max(0, linii.length - 40);

  // 1. separatorul clasic de semnătură: „--", „__", „———"
  for (let i = linii.length - 1; i >= deUnde; i--) {
    if (/^\s*([-_—–=*]{2,})\s*$/.test(linii[i])) return linii.slice(i + 1);
  }
  // 2. formula de încheiere („Cu stimă,", „Best regards,")
  for (let i = linii.length - 1; i >= deUnde; i--) {
    if (INCHEIERE.test(linii[i])) return linii.slice(i + 1);
  }
  // 3. ultimele douăsprezece rânduri
  return linii.slice(-12);
}

// Telefoane românești. Mobil 07xx xxx xxx, fix 0xx(x) xxx xxx, cu sau fără
// prefixul de țară, cu orice fel de despărțitor între grupuri.
const TELEFON = /(?:\+?\s?4?\s?0|\(0\))\s?[.\-]?\s?(\d[\s.\-()]?){8,11}/g;

function curataTelefon(brut) {
  let d = String(brut || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+40")) d = "0" + d.slice(3);
  else if (d.startsWith("0040")) d = "0" + d.slice(4);
  else if (d.startsWith("40") && d.length === 11) d = "0" + d.slice(2);
  if (!/^0\d{8,9}$/.test(d)) return null;
  return d;
}

// Întoarce { mobil, fix } — mobilul se preferă, că pe ăla răspunde omul.
function telefoaneDin(text) {
  const gasite = new Set();
  for (const m of String(text || "").matchAll(TELEFON)) {
    const t = curataTelefon(m[0]);
    if (t) gasite.add(t);
  }
  const toate = [...gasite];
  return {
    mobil: toate.find((t) => /^07\d{8}$/.test(t)) || null,
    fix: toate.find((t) => !/^07/.test(t)) || null,
  };
}

// Funcția din semnătură. Se caută rândul care conține una dintre meseriile
// astea și care nu e deja altceva (adresă, telefon, site).
const FUNCTII = new RegExp(
  `(?<![${LITERA}])(director|manager|agent|responsabil|[șs]ef|administrator|specialist|coordonator|consilier|reprezentant|achizi[țt]ii|aprovizionare|v[âa]nz[ăa]ri|desfacere|sales|purchasing|procurement|buyer|logistic[ăa]|transport|marketing|ceo|cfo|cto|coo|office|assistant|asistent|secretar|contabil|economist|inginer|tehnic|export|import|key account|business development|owner|partner|founder)(?![${LITERA}])`,
  "i"
);

function functiaDin(linii) {
  for (const l of linii) {
    const t = String(l || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 90) continue;
    if (/@|https?:|www\./i.test(t)) continue;
    if (curataTelefon(t)) continue;
    if (!FUNCTII.test(t)) continue;
    // „Mobil: 0722..." conține „mobil", dar nu e funcție — se sare dacă are
    // mai multe cifre decât litere.
    const cifre = (t.match(/\d/g) || []).length;
    if (cifre > 4) continue;
    return t.replace(/^[\s|•·*\-–—]+/, "").replace(/[\s|•·*\-–—,;]+$/, "").slice(0, 80);
  }
  return null;
}

// Un nume de om: două-patru cuvinte, fiecare început cu literă mare, fără
// cifre și fără cuvinte de firmă. Se folosește doar când numele din antetul
// „De la" nu e bun.
function numeDin(linii) {
  for (const l of linii.slice(0, 6)) {
    const t = String(l || "").replace(/\s+/g, " ").trim().replace(/^[\s|•·*\-–—]+/, "");
    if (!t || t.length > 60) continue;
    if (/[\d@]|https?:|www\./i.test(t)) continue;
    const cuvinte = t.split(" ").filter(Boolean);
    if (cuvinte.length < 2 || cuvinte.length > 4) continue;
    if (!cuvinte.every((c) => /^[A-ZĂÂÎȘȚ]/.test(c))) continue;
    if (FUNCTII.test(t)) continue;
    if (pareFirma(t, "")) continue;
    return t;
  }
  return null;
}

// Tot ce se poate scoate dintr-un mesaj. Întoarce null când nu e nimic de
// luat — și e în regulă: majoritatea mesajelor n-au semnătură folositoare.
function culegeDinMesaj(m) {
  const domeniu = String(m.de_la_domeniu || "").toLowerCase();
  if (!domeniu || DOMENII_PUBLICE.has(domeniu)) return null;

  const bloc = bloculSemnaturii(m.corp);
  const textBloc = bloc.join("\n");

  // Numele: întâi cel din antet (cel mai de încredere), apoi din semnătură.
  let nume = String(m.de_la_nume || "").replace(/\s+/g, " ").trim();
  if (!nume || pareFirma(nume, m.partener_nume || "")) nume = numeDin(bloc) || "";
  if (!nume || pareFirma(nume, m.partener_nume || "")) return null;

  const { mobil, fix } = telefoaneDin(textBloc);
  return {
    nume,
    email: String(m.de_la || "").trim().toLowerCase() || null,
    functie: functiaDin(bloc),
    telefon: mobil || fix,
  };
}

// ---- scrierea în Contacte ---------------------------------------------------

// Un om se recunoaște după firmă + nume, la fel ca la butonul „Adună
// contactele din ERP". Dacă îl găsim, îi completăm golurile; dacă nu, îl
// adăugăm. În niciun caz nu stricăm ce a scris cineva cu mâna.
async function pune(contact, partenerId, rezumat) {
  // Potrivirea numelui se face în JavaScript, nu în SQL: normNume() taie
  // punctele și virgulele și strânge spațiile, iar o normalizare scrisă a doua
  // oară în SQL s-ar depărta de ea la prima modificare. Atunci serviciul ar
  // adăuga a doua oară oameni care există deja, și nimeni n-ar observa până
  // când lista de contacte ar fi dublă.
  const aiCasei = await db
    .prepare("SELECT id, nume, email, telefon, functie FROM mk_contacte WHERE activ = 1 AND partener_id = ? ORDER BY id")
    .all(partenerId);
  const cautat = normNume(contact.nume);
  const existent = aiCasei.find((x) => normNume(x.nume) === cautat) || null;

  if (!existent) {
    await db
      .prepare(
        `INSERT INTO mk_contacte (partener_id, nume, functie, email, telefon, sursa)
         VALUES (?, ?, ?, ?, ?, 'semnatura')`
      )
      .run(partenerId, contact.nume, contact.functie, contact.email, contact.telefon);
    rezumat.adaugati++;
    return "adăugat";
  }

  // Doar golurile. „COALESCE(NULLIF(x,''), ?)" ar fi mai scurt, dar atunci
  // n-am ști dacă am schimbat ceva, iar rezumatul ar minți.
  const set = [];
  const args = [];
  if (!String(existent.email || "").trim() && contact.email) { set.push("email = ?"); args.push(contact.email); }
  if (!String(existent.telefon || "").trim() && contact.telefon) { set.push("telefon = ?"); args.push(contact.telefon); }
  if (!String(existent.functie || "").trim() && contact.functie) { set.push("functie = ?"); args.push(contact.functie); }
  if (!set.length) return "neatins";

  args.push(existent.id);
  await db.prepare(`UPDATE mk_contacte SET ${set.join(", ")} WHERE id = ?`).run(...args);
  rezumat.completati++;
  return "completat";
}


// ============================================================================
// CERERI ȘI COMENZI VENITE PE EMAIL
// ============================================================================
//
// Rulează la FIECARE sincronizare (5 minute), nu noaptea. Un client care
// scrie luni la 09:00 și află de el marți la 02:00 a pierdut 17 din cele 24
// de ore de răspuns înainte ca agentul lui să afle că există. Semnăturile pot
// aștepta noaptea; un termen de răspuns nu poate.
//
// Ce face, pe scurt:
//   - o CERERE („ne puteți trimite o ofertă pentru…") naște un task pentru
//     agentul clientului, cu scadența la 24 de ore de la ora mesajului;
//   - o COMANDĂ („vă rugăm să ne livrați 200 de cutii") naște și ea un task,
//     plus o comandă în CIORNĂ. Ciorna nu pleacă nicăieri: anunțul pe email
//     către birou și depozit pleacă abia când agentul apasă „Validează".
//
// Regula care ține totul în frâu: la îndoială, task. Un task în plus costă
// un clic. O comandă falsă intrată în flux costă un telefon de scuze.

// Cine ne scrie ca să primească un răspuns, nu ca să ne informeze.
const CERERE = new RegExp(
  [
    "solicit(are|am|ăm)", "cerere de (ofert|pre[țt])", "cerem", "a[șs] dori", "am dori",
    "ne pute[țt]i", "pute[țt]i s[ăa] ne", "v[ăa] rug[ăa]m s[ăa] ne (transmite[țt]i|trimite[țt]i|comunica[țt]i)",
    "a[șs]tept(ăm|am) (o )?ofert", "ofertare", "ce pre[țt]", "care (e|este) pre[țt]ul",
    "ave[țt]i (disponibil|în stoc|in stoc)", "stoc disponibil", "termen de livrare",
    "request for quot", "\\brfq\\b", "please (quote|send|advise)", "could you (send|provide|quote)",
    "kindly (send|provide)", "we would like to (receive|know)",
  ].join("|"),
  "i"
);

// Cine ne scrie ca să cumpere. Verbele sunt la modul hotărât, nu întrebător.
const COMANDA = new RegExp(
  [
    "plas(ăm|am) comand", "trimite[țt]i comanda", "comand(ăm|am) ", "dorim s[ăa] comand",
    "v[ăa] rog s[ăa] ne livra[țt]i", "v[ăa] rug[ăa]m s[ăa] ne livra[țt]i", "confirm(ăm|am) comanda",
    "comand[ăa] ferm", "purchase order", "\\bp\\.?o\\.? (no|nr|number)", "we order", "place (an )?order",
  ].join("|"),
  "i"
);

// Roboți: confirmări, newslettere, facturi automate. Nu cer răspuns de la om.
const AUTOMAT = /^(no-?reply|noreply|do-?not-?reply|automat|auto|mailer-daemon|postmaster|notification[s]?|bounce)@/i;
const SUBIECT_AUTOMAT = /(newsletter|dezabonare|unsubscribe|out of office|absent din birou|delivery status notification|undeliverable|factura electronic|e-?factura|spv)/i;

// O linie de comandă recunoscută din text: „200 buc cutii D10" sau
// „cutii D10 - 200 buc". Se cere o cantitate CU unitate de măsură; un număr
// singur poate fi orice — un cod de produs, o dată, un număr de telefon.
const UM = "buc|bucati|buc[ăa][țt]i|kg|kilograme|to|tone|t|ml|m|mp|m2|mc|m3|l|litri|role|paleti|pale[țt]i|cutii|set|seturi|colete";
const LINIE_CANTITATE = new RegExp(`(\\d{1,3}(?:[.\\s]\\d{3})*(?:[.,]\\d+)?)\\s*(${UM})(?![a-zăâîșț])`, "i");

function pareRobot(m) {
  if (AUTOMAT.test(String(m.de_la || ""))) return true;
  if (SUBIECT_AUTOMAT.test(String(m.subiect || ""))) return true;
  return false;
}

// Ce fel de mesaj e. Întoarce "comanda", "cerere" sau null.
//
// Ordinea contează: un mesaj poate să sune și a cerere, și a comandă
// („vă rugăm să ne trimiteți oferta și apoi comandăm 200 buc"). Comanda cere
// mai multă certitudine — cuvinte de comandă ȘI o cantitate cu unitate de
// măsură — tocmai ca să nu fure din cereri.
function felulMesajului(m) {
  if (pareRobot(m)) return null;
  const text = `${m.subiect || ""}
${m.corp || ""}`;
  const areComanda = COMANDA.test(text);
  const areCantitate = LINIE_CANTITATE.test(text);
  if (areComanda && areCantitate) return "comanda";
  if (areComanda || CERERE.test(text)) return "cerere";
  return null;
}

// Liniile de comandă găsite în text. Conservator: doar rândurile care au și
// cantitate, și unitate de măsură, și ceva care seamănă a denumire.
function liniiDinText(corp) {
  const gasite = [];
  for (const l of String(corp || "").replace(/\r/g, "").split("\n")) {
    const t = l.replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) continue;
    const m = t.match(LINIE_CANTITATE);
    if (!m) continue;
    const denumire = t.replace(m[0], " ").replace(/[-–—:|]+/g, " ").replace(/\s+/g, " ").trim();
    if (denumire.length < 3) continue;
    const cant = Number(String(m[1]).replace(/[.\s]/g, "").replace(",", "."));
    if (!Number.isFinite(cant) || cant <= 0) continue;
    gasite.push({ denumire: denumire.slice(0, 160), cantitate: cant, um: m[2].toLowerCase(), linie: t });
    if (gasite.length >= 30) break;
  }
  return gasite;
}

// ---- cine e agentul clientului ---------------------------------------------
// Alocarea explicită bate agent_id-ul de pe fișă, iar dintre alocările pe
// procente câștigă cea mai mare. Dacă nu e nimeni, taskul rămâne neatribuit și
// se vede în lista de la Taskuri — mai bine un task orfan, pe care îl ia
// cineva, decât unul pus la un agent care n-are treabă cu clientul.
async function agentulClientului(partenerId) {
  const a = await db
    .prepare(
      `SELECT utilizator_id FROM alocari_clienti WHERE partener_id = ? ORDER BY procent DESC, id LIMIT 1`
    )
    .get(partenerId);
  if (a && a.utilizator_id) return Number(a.utilizator_id);
  const p = await db.prepare("SELECT agent_id FROM parteneri WHERE id = ?").get(partenerId);
  return p && p.agent_id ? Number(p.agent_id) : null;
}

// 24 de ore de la ora mesajului. Se întorc amândouă: data (pentru coloana
// veche, după care se sortează și se colorează întârziatele) și momentul
// exact (pentru când termenul chiar contează).
function scadentaLa24h(dataMesaj) {
  const t = new Date(String(dataMesaj || "").replace(" ", "T"));
  const baza = Number.isFinite(t.getTime()) ? t : new Date();
  const la = new Date(baza.getTime() + 24 * 3600 * 1000);
  return { zi: la.toISOString().slice(0, 10), moment: la.toISOString().slice(0, 19).replace("T", " ") };
}

function scurt(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function faceTask(m, fel, agentId) {
  const s = scadentaLa24h(m.data);
  const titlu =
    (fel === "comanda" ? "Comandă pe email: " : "Cerere pe email: ") +
    (scurt(m.subiect, 70) || "fără subiect");
  const descriere = [
    `De la: ${m.de_la_nume ? m.de_la_nume + " <" + m.de_la + ">" : m.de_la}`,
    `Primit: ${String(m.data || "").slice(0, 16)}`,
    `Termen de răspuns: ${s.moment} (24 de ore)`,
    "",
    scurt(m.snippet || m.corp, 600),
    "",
    `Mesajul întreg: /email/${m.id}`,
  ].join("\n");

  const r = await db
    .prepare(
      `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, scadenta_la, atribuit_lui, partener_id)
       VALUES (?, ?, 'email', ?, 'deschis', ?, ?, ?, ?) RETURNING id`
    )
    .run(titlu, descriere, fel === "comanda" ? "urgenta" : "ridicata", s.zi, s.moment, agentId, m.partener_id);
  return r && r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
}

// Comanda se naște în CIORNĂ. Nu intră în fluxul depozitului, nu se poate
// factura, și — cel mai important — nu pleacă niciun email. Agentul o
// deschide, corectează liniile pe care le-am citit din text, și abia el apasă
// butonul care o face „nouă" și trimite anunțul.
async function faceComandaCiorna(m, agentId) {
  const r = await db
    .prepare(
      `INSERT INTO comenzi (partener_id, status, observatii, agent_id, sursa, email_mesaj_id)
       VALUES (?, 'ciorna', ?, ?, 'email', ?) RETURNING id`
    )
    .run(
      m.partener_id,
      `Citită automat din emailul „${scurt(m.subiect, 80)}" de la ${m.de_la}, primit ${String(m.data || "").slice(0, 16)}. Verifică liniile înainte de validare.`,
      agentId,
      m.id
    );
  const comandaId = r && r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
  if (!comandaId) return null;

  // Liniile intră doar dacă produsul se recunoaște. Un produs ghicit greșit
  // într-o comandă e mai rău decât o comandă goală: goala se completează în
  // două minute, greșita pleacă mai departe fără să observe nimeni.
  for (const l of liniiDinText(m.corp)) {
    const p = await db
      .prepare("SELECT id FROM produse WHERE lower(denumire) = lower(?) OR lower(cod) = lower(?) ORDER BY id LIMIT 1")
      .get(l.denumire, l.denumire);
    if (!p) continue;
    await db
      .prepare("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, 0)")
      .run(comandaId, p.id, l.cantitate);
  }
  return comandaId;
}

// ---- rularea clasificării ---------------------------------------------------
async function clasificaMesaje({ zile } = {}) {
  const deLa = new Date(Date.now() - (zile || 3) * 86400000).toISOString().slice(0, 10);
  const rezumat = { citite: 0, cereri: 0, comenzi: 0, taskuri: 0, fara_agent: 0, erori: 0 };

  let mesaje = [];
  try {
    mesaje = await db
      .prepare(
        `SELECT m.id, m.de_la, m.de_la_nume, m.subiect, m.snippet, m.corp, m.data, m.partener_id
           FROM email_mesaje m
          WHERE m.activ = 1 AND m.directie = 'primit'
            AND m.partener_id IS NOT NULL
            AND m.clasificat_la IS NULL
            AND COALESCE(m.data,'') >= ?
          ORDER BY m.data
          LIMIT 500`
      )
      .all(deLa);
  } catch (e) {
    return Object.assign(rezumat, { eroare: String(e.message || e).slice(0, 200) });
  }

  for (const m of mesaje) {
    rezumat.citite++;
    try {
      const fel = felulMesajului(m);
      // Se marchează ca văzut chiar și când nu e nici cerere, nici comandă:
      // altfel l-am reciti la fiecare cinci minute, la nesfârșit.
      if (!fel) {
        await db.prepare("UPDATE email_mesaje SET clasificat_la = ? WHERE id = ?").run(acum(), m.id);
        continue;
      }
      const agentId = await agentulClientului(m.partener_id);
      if (!agentId) rezumat.fara_agent++;

      const taskId = await faceTask(m, fel, agentId);
      if (taskId) rezumat.taskuri++;

      let comandaId = null;
      if (fel === "comanda") {
        comandaId = await faceComandaCiorna(m, agentId);
        if (comandaId && taskId) {
          await db.prepare("UPDATE taskuri SET comanda_id = ? WHERE id = ?").run(comandaId, taskId);
        }
        rezumat.comenzi++;
      } else {
        rezumat.cereri++;
      }

      await db
        .prepare("UPDATE email_mesaje SET fel = ?, task_id = ?, comanda_id = ?, clasificat_la = ? WHERE id = ?")
        .run(fel, taskId, comandaId, acum(), m.id);
    } catch (e) {
      rezumat.erori++;
    }
  }
  return rezumat;
}

// ---- rularea ----------------------------------------------------------------

async function culegeSemnaturi({ zile } = {}) {
  const deLa = new Date(Date.now() - (zile || ZILE_INAPOI) * 86400000).toISOString().slice(0, 10);
  const rezumat = { citite: 0, cuSemnatura: 0, adaugati: 0, completati: 0, sarite: 0, erori: 0 };

  let mesaje = [];
  try {
    mesaje = await db
      .prepare(
        `SELECT m.id, m.de_la, m.de_la_nume, m.de_la_domeniu, m.corp, m.partener_id,
                p.nume AS partener_nume
           FROM email_mesaje m
           JOIN parteneri p ON p.id = m.partener_id
          WHERE m.activ = 1 AND m.directie = 'primit'
            AND m.partener_id IS NOT NULL
            AND COALESCE(m.data,'') >= ?
          ORDER BY m.data DESC
          LIMIT ${MAX_MESAJE}`
      )
      .all(deLa);
  } catch (e) {
    // Tabelele de email pot lipsi până rulează migrarea.
    return Object.assign(rezumat, { eroare: String(e.message || e).slice(0, 200) });
  }

  for (const m of mesaje) {
    rezumat.citite++;
    try {
      const c = culegeDinMesaj(m);
      if (!c) { rezumat.sarite++; continue; }
      rezumat.cuSemnatura++;
      await pune(c, m.partener_id, rezumat);
    } catch (e) {
      rezumat.erori++;
    }
  }
  return rezumat;
}

async function ruleaza({ zile } = {}) {
  const inceput = Date.now();
  const semnaturi = await culegeSemnaturi({ zile });
  // Clasificarea merge la fiecare sincronizare; aici e doar plasa de siguranță
  // pentru ce s-a ratat (server căzut, bază indisponibilă), cu fereastra mai
  // largă decât cea de la sincronizare.
  const clasificare = await clasificaMesaje({ zile: zile || ZILE_INAPOI });
  const rezumat = {
    la: acum(),
    secunde: Math.round((Date.now() - inceput) / 1000),
    semnaturi,
    clasificare,
  };
  try {
    await db
      .prepare("INSERT INTO culegere_istoric (rulat_la, rezumat) VALUES (?, ?)")
      .run(rezumat.la, JSON.stringify(rezumat));
  } catch (e) {
    /* istoricul e util, nu vital */
  }
  return rezumat;
}

// Verifică din oră în oră, lucrează o dată pe zi, după ora 2. Aceeași formă ca
// la aniversări: un serviciu care ratează o noapte fiindcă serverul dormea nu
// trebuie să sară peste zi, ci s-o facă la prima ocazie.
let ultimaZi = null;
function porneste() {
  const bate = async () => {
    try {
      const zi = azi();
      if (new Date().getHours() < ORA_RULARE || ultimaZi === zi) return;
      ultimaZi = zi;
      const r = await ruleaza();
      console.log(
        `[culegere] semnături: ${r.semnaturi.adaugati} contacte noi, ${r.semnaturi.completati} completate, din ${r.semnaturi.citite} mesaje (${r.secunde}s)`
      );
    } catch (e) {
      console.error("[culegere] eroare:", e.message);
    }
  };
  setTimeout(bate, 90 * 1000);
  setInterval(bate, 30 * 60 * 1000).unref();
}

// ---- pagina -----------------------------------------------------------------

function register(router) {
  router.get("/email/culegere", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    let istoric = [];
    try {
      istoric = await db.prepare("SELECT * FROM culegere_istoric ORDER BY id DESC LIMIT 20").all();
    } catch (e) {
      istoric = [];
    }

    const randuri = istoric.map((r) => {
      let j = {};
      try { j = JSON.parse(r.rezumat || "{}"); } catch (e) { j = {}; }
      const s = j.semnaturi || {};
      const k = j.clasificare || {};
      return [
        esc(String(r.rulat_la || "").slice(0, 16)),
        String(s.citite || 0),
        `<strong>${s.adaugati || 0}</strong>`,
        String(s.completati || 0),
        String(k.cereri || 0),
        String(k.comenzi || 0),
        (s.erori || 0) + (k.erori || 0) ? `<span class="badge rosu">${(s.erori || 0) + (k.erori || 0)}</span>` : "—",
        `${j.secunde || 0}s`,
      ];
    });

    const proaspete = await db
      .prepare(
        `SELECT c.id, c.nume, c.functie, c.email, c.telefon, c.creat_la, p.nume AS firma, p.tip
           FROM mk_contacte c LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE c.activ = 1 AND c.sursa = 'semnatura'
          ORDER BY c.id DESC LIMIT 50`
      )
      .all()
      .catch(() => []);

    const body = `
      <p style="color:var(--text-muted);font-size:13px;max-width:820px">
        <strong>Semnăturile</strong> se citesc în fiecare noapte, la ora ${ORA_RULARE}:00, din emailurile primite în
        ultimele ${ZILE_INAPOI} zile. Din ele ies oamenii — nume, funcție, telefon — și intră în Contacte, legați de
        firma de la care au scris. Nu se suprascrie nimic scris de mână: se completează doar golurile.
      </p>
      <p style="color:var(--text-muted);font-size:13px;max-width:820px">
        <strong>Cererile și comenzile</strong> nu așteaptă noaptea: se prind la fiecare sincronizare, deci la
        5 minute. O cerere naște un task pentru agentul clientului, cu termen de răspuns la 24 de ore.
        O comandă naște și un task, și o comandă în <em>ciornă</em> — care nu pleacă nicăieri până n-o
        validează agentul. Rularea de noapte trece încă o dată peste ce s-a ratat.
      </p>

      <form method="post" action="/email/culegere/acum" class="inline-form" style="margin:14px 0">
        <button class="btn secondary" type="submit">Rulează acum</button>
        <span style="font-size:12px;color:var(--text-muted)">Nu strică nimic: aceleași reguli ca noaptea.</span>
      </form>

      <h2>Ultimele rulări</h2>
      ${
        randuri.length
          ? table(["Când", "Mesaje citite", "Contacte noi", "Completate", "Cereri", "Comenzi", "Erori", "Durata"], randuri)
          : "<p>N-a rulat încă. Prima rulare e la ora " + ORA_RULARE + ":00, sau apeși butonul de mai sus.</p>"
      }

      <h2>Contacte venite din semnături</h2>
      ${
        proaspete.length
          ? table(
              ["Nume", "Funcție", "Firma", "Email", "Telefon", "Când"],
              proaspete.map((c) => [
                `<a href="/marketing/contact/${c.id}">${esc(c.nume)}</a>`,
                esc(c.functie || "—"),
                esc(c.firma || "—"),
                c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—",
                esc(c.telefon || "—"),
                esc(String(c.creat_la || "").slice(0, 16)),
              ])
            )
          : "<p>Încă niciunul.</p>"
      }`;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Culegere din emailuri", active: "/email", body }));
  });

  router.post("/email/culegere/acum", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/email/culegere");
    await ruleaza();
    redirect(ctx.res, "/email/culegere");
  });
}

module.exports = {
  register,
  porneste,
  ruleaza,
  culegeSemnaturi,
  clasificaMesaje,
  felulMesajului,
  liniiDinText,
  scadentaLa24h,
  agentulClientului,
  // exportate pentru teste: sunt funcții pure și acolo se prind greșelile
  bloculSemnaturii,
  telefoaneDin,
  curataTelefon,
  functiaDin,
  numeDin,
  culegeDinMesaj,
  ORA_RULARE,
};
