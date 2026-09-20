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
  const rezumat = {
    la: acum(),
    secunde: Math.round((Date.now() - inceput) / 1000),
    semnaturi,
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
      return [
        esc(String(r.rulat_la || "").slice(0, 16)),
        String(s.citite || 0),
        String(s.cuSemnatura || 0),
        `<strong>${s.adaugati || 0}</strong>`,
        String(s.completati || 0),
        s.erori ? `<span class="badge rosu">${s.erori}</span>` : "—",
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
        În fiecare noapte, la ora ${ORA_RULARE}:00, ERP-ul citește semnăturile din emailurile primite în
        ultimele ${ZILE_INAPOI} zile și scoate din ele oamenii: nume, funcție, telefon. Îi pune în Contacte,
        legați de firma de la care au scris. Nu suprascrie nimic scris de mână — completează doar golurile.
      </p>

      <form method="post" action="/email/culegere/acum" class="inline-form" style="margin:14px 0">
        <button class="btn secondary" type="submit">Rulează acum</button>
        <span style="font-size:12px;color:var(--text-muted)">Nu strică nimic: aceleași reguli ca noaptea.</span>
      </form>

      <h2>Ultimele rulări</h2>
      ${
        randuri.length
          ? table(["Când", "Mesaje citite", "Cu semnătură", "Contacte noi", "Completate", "Erori", "Durata"], randuri)
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
  // exportate pentru teste: sunt funcții pure și acolo se prind greșelile
  bloculSemnaturii,
  telefoaneDin,
  curataTelefon,
  functiaDin,
  numeDin,
  culegeDinMesaj,
  ORA_RULARE,
};
