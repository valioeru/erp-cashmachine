"use strict";
// Scadențe și recuperare de creanțe.
//
// Regulile, exact cum le-a cerut Vali:
//   • o săptămână întârziere = GALBEN, mai mult = ROȘU, la zi = VERDE;
//   • agentul poate bifa „notificare automată" pe o factură (email zilnic,
//     adaptat la cât de veche e restanța) sau poate trimite manual;
//   • pentru un client ROȘU agentul nu mai poate plasa comenzi până nu
//     redevine verde;
//   • se văd și facturile care URMEAZĂ să fie scadente, iar cele cu scadență
//     în următoarele 3 zile pot primi o notificare politicoasă;
//   • dacă un client stă ROȘU cu o factură de 3 luni, toate notificările pe
//     el devin automate și agentul nu le mai poate opri — doar administratorul.
//
// Culoarea NU se stochează: se calculează din solduri. Un client care plătește
// azi trebuie să fie verde azi, fără să apese cineva un buton.
const db = require("../lib/db");
const { esc, layout, table, money, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const mail = require("../lib/mail");
const { ALOC } = require("./alocari");

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";

// Praguri, într-un singur loc, ca să se schimbe ușor dacă se schimbă politica.
const ZILE_GALBEN = 7; // peste atâtea zile de întârziere clientul devine roșu
const ZILE_BLOCARE_TOTALA = 90; // 3 luni pe roșu ⇒ notificări obligatoriu automate
const ZILE_PREAVIZ = 3; // cu atâtea zile înainte de scadență anunțăm politicos
const TERMEN_IMPLICIT = 30; // facturile importate fără scadență: emitere + 30 zile

function azi() {
  return new Date().toISOString().slice(0, 10);
}

// De la ce dată încolo scadențarul e „viu".
//
// Motivul e serios: istoricul importat din SmartBill are 3.000 de facturi și
// doar 1.400 de încasări. Multe facturi vechi apar neîncasate pentru că plata
// lor n-a fost importată, nu pentru că n-ar fi fost plătită — sunt acolo
// facturi din 2021 cu „sold". Dacă am lăsa regula de 3 luni să se aplice pe
// tot istoricul, în ziua în care cineva configurează contul de email ar pleca
// o sută de somații de plată către clienți care au achitat demult.
//
// Așa că notificările automate și blocarea comenzilor se aplică DOAR
// facturilor emise de la data asta încolo. Implicit e ziua în care s-a
// pornit scadențarul; adminul o poate muta înapoi când e sigur pe date.
let _start;
let _startInFlight = null;
async function dataStart() {
  if (_start) return _start;
  // O singură citire, chiar dacă pagina o cere din trei locuri odată —
  // altfel două inserturi paralele se bat pe aceeași cheie.
  if (!_startInFlight) {
    _startInFlight = (async () => {
      const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'scadentar_de_la'").get();
      if (r && r.valoare) return String(r.valoare).slice(0, 10);
      const azi_ = azi();
      try {
        await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('scadentar_de_la', ?, ?)").run(azi_, azi_);
      } catch (e) {
        const r2 = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'scadentar_de_la'").get();
        if (r2 && r2.valoare) return String(r2.valoare).slice(0, 10);
      }
      return azi_;
    })()
      .then((v) => {
        _start = v;
        _startInFlight = null;
        return v;
      })
      .catch((e) => {
        _startInFlight = null;
        throw e;
      });
  }
  return _startInFlight;
}
async function setDataStart(d) {
  const v = String(d || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = 'scadentar_de_la'").get();
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = 'scadentar_de_la'").run(v, azi());
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('scadentar_de_la', ?, ?)").run(v, azi());
  _start = v;
  return v;
}
function zileIntre(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
function scadentaEfectiva(f) {
  const s = f.data_scadenta ? String(f.data_scadenta).slice(0, 10) : "";
  if (s && s.length === 10) return s;
  const e = f.data_emiterii ? String(f.data_emiterii).slice(0, 10) : "";
  if (!e) return null;
  const d = new Date(e);
  d.setDate(d.getDate() + TERMEN_IMPLICIT);
  return d.toISOString().slice(0, 10);
}
function culoare(zileIntarziere) {
  if (zileIntarziere <= 0) return "verde";
  if (zileIntarziere <= ZILE_GALBEN) return "galben";
  return "rosu";
}
const BADGE = { verde: "verde", galben: "galben", rosu: "rosu", neverificat: "gri" };
const ETICHETA = { verde: "la zi", galben: "întârziere mică", rosu: "restanță" };

// ------------------------------------------------------------------
// Datele
// ------------------------------------------------------------------
// Toate facturile de vânzare cu sold rămas, cu agentul lor și cu starea
// calculată. Un singur query — pagina asta se deschide des.
async function facturiCuSold(agentId) {
  const args = [];
  let filtru = "";
  if (agentId) {
    filtru = ` AND EXISTS (SELECT 1 FROM ${ALOC} a WHERE a.partener_id = f.partener_id AND a.utilizator_id = ? AND a.procent > 0)`;
    args.push(agentId);
  }
  const randuri = await db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta,
              f.notificare_auto, f.partener_id,
              p.nume AS client, p.email AS email_client, p.notificari_oprite,
              COALESCE(t.total, 0) AS total, COALESCE(pl.platit, 0) AS platit,
              (SELECT MAX(n.trimis_la) FROM notificari_facturi n WHERE n.factura_id = f.id) AS ultima_notificare
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany, 0) = 0
          AND COALESCE(t.total, 0) - COALESCE(pl.platit, 0) > 0.5${filtru}
        ORDER BY f.data_scadenta, f.id`
    )
    .all(...args);

  const aziStr = azi();
  const deLa = await dataStart();
  return randuri.map((f) => {
    const scad = scadentaEfectiva(f);
    const zile = scad ? zileIntre(scad, aziStr) : 0; // pozitiv = întârziere
    const emisa = f.data_emiterii ? String(f.data_emiterii).slice(0, 10) : "";
    const neverificat = !!(deLa && emisa && emisa < deLa); // istoric, nu se automatizează
    return {
      ...f,
      scadenta: scad,
      sold: Number(f.total) - Number(f.platit),
      zile,
      neverificat,
      stare: neverificat ? "neverificat" : culoare(zile),
    };
  });
}

// Starea fiecărui client: cea mai rea factură a lui decide culoarea.
function stariDinFacturi(facturi) {
  const m = new Map();
  for (const f of facturi) {
    const c = m.get(f.partener_id) || { partener_id: f.partener_id, nume: f.client, zileMax: 0, sold: 0, soldNeverificat: 0, stare: "verde", notificari_oprite: f.notificari_oprite };
    if (f.neverificat) {
      c.soldNeverificat += f.sold;
    } else {
      c.sold += f.sold;
      if (f.zile > c.zileMax) c.zileMax = f.zile;
    }
    m.set(f.partener_id, c);
  }
  for (const c of m.values()) {
    c.stare = culoare(c.zileMax);
    // Trei luni pe roșu: regimul automat devine obligatoriu pentru agent.
    c.blocatAutomat = c.zileMax >= ZILE_BLOCARE_TOTALA;
  }
  return m;
}

// Starea unui singur client — folosită de comenzi/oferte ca să blocheze
// comenzile noi pe clienții roșii.
async function stareClient(partenerId) {
  const f = await db
    .prepare(
      `SELECT f.id, f.data_emiterii, f.data_scadenta,
              COALESCE(t.total,0) AS total, COALESCE(pl.platit,0) AS platit
         FROM facturi f
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
        WHERE f.partener_id = ? AND f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
          AND COALESCE(f.intercompany,0) = 0
          AND COALESCE(t.total,0) - COALESCE(pl.platit,0) > 0.5`
    )
    .all(partenerId);
  const aziStr = azi();
  const deLa = await dataStart();
  let zileMax = 0;
  let sold = 0;
  for (const r of f) {
    const emisa = r.data_emiterii ? String(r.data_emiterii).slice(0, 10) : "";
    if (deLa && emisa && emisa < deLa) continue; // sold neverificat, nu blocăm pe el
    const scad = scadentaEfectiva(r);
    const z = scad ? zileIntre(scad, aziStr) : 0;
    if (z > zileMax) zileMax = z;
    sold += Number(r.total) - Number(r.platit);
  }
  return { stare: culoare(zileMax), zileMax, sold, blocatAutomat: zileMax >= ZILE_BLOCARE_TOTALA };
}

// Poate agentul să comande pentru clientul ăsta? Adminul poate oricând —
// el e cel care decide să-și asume riscul.
async function poateComanda(user, partenerId) {
  if (!user) return { ok: false, motiv: "Nu ești autentificat." };
  if (user.rol === "admin") return { ok: true };
  const s = await stareClient(partenerId);
  if (s.stare === "rosu") {
    return {
      ok: false,
      motiv: `Clientul are ${money(s.sold)} restanți, cu o factură întârziată de ${s.zileMax} zile. Comenzile se deblochează când soldul restant e adus la zi.`,
      stare: s,
    };
  }
  return { ok: true, stare: s };
}

// ------------------------------------------------------------------
// Textul emailului
// ------------------------------------------------------------------
// Se adaptează la vechimea restanței: cu cât e mai veche, cu atât e mai
// fermă. Nu e nici agresivă, nici scuze — e o factură neplătită.
function compuneMesaj(f, firma) {
  const nrDoc = f.document_extern || [f.serie, f.numar].filter(Boolean).join(" ");
  const suma = money(f.sold);
  const scad = f.scadenta || "—";
  const semnatura = `\n\nCu stimă,\n${firma.nume}${firma.telefon ? `\nTel. ${firma.telefon}` : ""}${firma.email ? `\n${firma.email}` : ""}`;

  if (f.zile <= 0) {
    const inZile = -f.zile;
    return {
      subiect: `Reamintire: factura ${nrDoc} are scadența pe ${scad}`,
      corp:
        `Bună ziua,\n\nVă reamintim, cu titlu informativ, că factura ${nrDoc} în valoare de ${suma} ` +
        `are scadența pe ${scad}${inZile === 0 ? " — astăzi" : `, adică peste ${inZile} ${inZile === 1 ? "zi" : "zile"}`}.\n\n` +
        `Dacă plata e deja în curs, vă rugăm să ignorați acest mesaj.` +
        semnatura,
    };
  }
  if (f.zile <= ZILE_GALBEN) {
    return {
      subiect: `Factura ${nrDoc} — scadentă pe ${scad}`,
      corp:
        `Bună ziua,\n\nFactura ${nrDoc}, în valoare de ${suma}, a avut scadența pe ${scad} și figurează încă neîncasată ` +
        `(${f.zile} ${f.zile === 1 ? "zi" : "zile"} de la termen).\n\n` +
        `Se întâmplă des ca o factură să rămână pur și simplu în urmă la plăți. Dacă e cazul, vă rugăm să ne spuneți ` +
        `când putem aștepta plata; dacă e ceva neclar pe factură, o lămurim imediat.` +
        semnatura,
    };
  }
  if (f.zile < ZILE_BLOCARE_TOTALA) {
    return {
      subiect: `Restanță: factura ${nrDoc}, ${f.zile} zile de la scadență`,
      corp:
        `Bună ziua,\n\nFactura ${nrDoc}, în valoare de ${suma}, este neîncasată de ${f.zile} zile ` +
        `(scadentă pe ${scad}).\n\n` +
        `Vă rugăm să ne comunicați data la care se face plata. Până la stingerea restanței, livrările noi către ` +
        `dumneavoastră sunt suspendate.\n\nDacă există o problemă cu factura, spuneți-ne — o rezolvăm.` +
        semnatura,
    };
  }
  return {
    subiect: `Somație de plată — factura ${nrDoc}, ${f.zile} zile restanță`,
    corp:
      `Bună ziua,\n\nFactura ${nrDoc}, în valoare de ${suma}, este neachitată de ${f.zile} zile de la scadența din ${scad}.\n\n` +
      `Vă solicităm plata în cel mai scurt timp. În lipsa unui răspuns și a unei plăți, vom continua recuperarea ` +
      `creanței pe căile prevăzute de lege.\n\nDacă doriți o eșalonare, suntem deschiși la discuție — dar avem nevoie ` +
      `de un răspuns.` +
      semnatura,
  };
}

// Firma care semnează mesajul: cea marcată implicită, altfel prima din grup.
async function dateFirma() {
  let r = null;
  try {
    r = await db.prepare("SELECT nume FROM firme ORDER BY implicita DESC, id LIMIT 1").get();
  } catch (e) {
    r = null;
  }
  return { nume: (r && r.nume) || "Cash Machine SRL", telefon: "", email: "" };
}

// Cine trimite: agentul facturii dacă are SMTP configurat, altfel primul
// admin configurat. Fără niciun SMTP nu avem cum trimite, și spunem asta.
async function expeditorPentru(factura, userPreferat) {
  const candidati = [];
  if (userPreferat) candidati.push(userPreferat.id);
  if (factura.agent_id) candidati.push(factura.agent_id);
  const restul = await db.prepare("SELECT id FROM utilizatori WHERE activ = 1 AND smtp_host IS NOT NULL ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id").all();
  for (const r of restul) candidati.push(r.id);
  for (const id of candidati) {
    const u = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(id);
    const cfg = u && mail.configUtilizator(u);
    if (cfg) return { user: u, config: cfg };
  }
  return null;
}

async function trimiteNotificare(f, user, automat) {
  const firma = await dateFirma();
  const mesaj = compuneMesaj(f, firma);
  const catre = String(f.email_client || "").trim();
  let status = "trimis";
  let eroare = null;

  if (!catre) {
    status = "esuat";
    eroare = "Clientul nu are adresă de email în fișă.";
  } else {
    const exp = await expeditorPentru(f, user);
    if (!exp) {
      status = "esuat";
      eroare = "Niciun utilizator nu are contul de email configurat (Profilul meu → Email).";
    } else {
      try {
        await mail.trimite(exp.config, { catre: [catre], subiect: mesaj.subiect, corp: mesaj.corp });
      } catch (e) {
        status = "esuat";
        eroare = e.message;
      }
    }
  }

  await db
    .prepare(
      `INSERT INTO notificari_facturi (factura_id, partener_id, tip, zile, catre, subiect, corp, automat, status, eroare, utilizator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(f.id, f.partener_id, f.zile > 0 ? "intarziere" : "preaviz", f.zile, catre || null, mesaj.subiect, mesaj.corp, automat ? 1 : 0, status, eroare, user ? user.id : null);

  // Notificarea intră și în istoricul clientului: peste o lună nimeni nu-și
  // mai amintește dacă i s-a scris sau nu.
  if (status === "trimis") {
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'notificare', ?, ?, ?)")
      .run(f.partener_id, mesaj.subiect, `Trimisă ${automat ? "automat" : "manual"} către ${catre}.`, user ? user.id : null);
  }
  return { status, eroare, mesaj };
}

// ------------------------------------------------------------------
// Rulajul automat
// ------------------------------------------------------------------
// O factură cu notificare automată primește cel mult un email pe zi. Rutina
// e idempotentă: dacă s-a trimis deja azi, nu se mai trimite.
async function ruleazaNotificariAutomate() {
  const facturi = await facturiCuSold(null);
  const stari = stariDinFacturi(facturi);
  const aziStr = azi();
  let trimise = 0;
  let esuate = 0;

  for (const f of facturi) {
    if (f.neverificat) continue; // nu cerem bani pe facturi al căror istoric de plăți nu-l avem
    const st = stari.get(f.partener_id);
    const obligatoriu = st && st.blocatAutomat;
    const oprit = Number(f.notificari_oprite) === 1; // adminul a tăiat notificările pe client
    const auto = oprit ? false : obligatoriu || Number(f.notificare_auto) === 1;
    if (!auto) continue;
    // Trimitem doar pentru restanțe sau pentru scadențe foarte apropiate.
    if (f.zile <= 0 && -f.zile > ZILE_PREAVIZ) continue;
    if (f.ultima_notificare && String(f.ultima_notificare).slice(0, 10) >= aziStr) continue;
    const r = await trimiteNotificare(f, null, true);
    if (r.status === "trimis") trimise++;
    else esuate++;
  }
  return { trimise, esuate, verificate: facturi.length };
}

// Aplicația n-are un proces separat de fundal (e un singur web service pe
// Render), așa că rutina zilnică pornește la prima deschidere de pagină din
// zi și rulează în fundal, fără să țină cineva pagina în loc. E idempotentă:
// o factură primește cel mult un email pe zi, indiferent de câte ori se
// cheamă funcția.
let ziuaRulata = null;
let ruleazaAcum = false;
function poateRulaAzi() {
  const z = azi();
  if (ziuaRulata === z || ruleazaAcum) return false;
  ruleazaAcum = true;
  return true;
}
function porneste() {
  if (!poateRulaAzi()) return;
  const z = azi();
  ruleazaNotificariAutomate()
    .then((r) => {
      ziuaRulata = z;
      if (r.trimise || r.esuate) console.log(`[scadente] notificări automate: ${r.trimise} trimise, ${r.esuate} eșuate`);
    })
    .catch((e) => console.error("[scadente] rutina automată a eșuat:", e.message))
    .finally(() => {
      ruleazaAcum = false;
    });
}

// ------------------------------------------------------------------
// Blocul pentru dashboard-ul agentului
// ------------------------------------------------------------------
function randFactura(f, st, user) {
  const eAdmin = user.rol === "admin";
  if (f.neverificat) {
    const nr = f.document_extern || [f.serie, f.numar].filter(Boolean).join(" ");
    return [
      `<a href="/facturi/${f.id}">${esc(nr)}</a>`,
      `<a href="/parteneri/${f.partener_id}">${esc(f.client)}</a>`,
      esc(f.scadenta || "—"),
      `<span class="badge gri">sold neverificat</span>`,
      money(f.sold),
      `<span style="color:var(--text-muted);font-size:12px">—</span>`,
      `<form method="post" action="/scadente/${f.id}/trimite" class="inline-form"><button class="btn small secondary" type="submit">Trimite manual</button></form>`,
      f.ultima_notificare ? esc(String(f.ultima_notificare).slice(0, 10)) : "—",
    ];
  }
  const obligatoriu = st && st.blocatAutomat;
  const oprit = Number(f.notificari_oprite) === 1;
  const autoEfectiv = oprit ? false : obligatoriu || Number(f.notificare_auto) === 1;
  const potSchimba = eAdmin || (!obligatoriu && !oprit);
  const nrDoc = f.document_extern || [f.serie, f.numar].filter(Boolean).join(" ");

  const comutator = potSchimba
    ? `<form method="post" action="/scadente/${f.id}/auto" class="inline-form">
         <input type="hidden" name="valoare" value="${autoEfectiv ? 0 : 1}">
         <button class="btn small ${autoEfectiv ? "" : "secondary"}" type="submit">${autoEfectiv ? "automat: DA" : "automat: nu"}</button>
       </form>`
    : `<span class="badge ${oprit ? "gri" : "rosu"}" title="${oprit ? "Notificările pe acest client sunt oprite de administrator" : "Client cu restanță de peste 3 luni — notificările sunt automate și doar adminul le poate schimba"}">${oprit ? "oprit de admin" : "automat (obligatoriu)"}</span>`;

  return [
    `<a href="/facturi/${f.id}">${esc(nrDoc)}</a>`,
    `<a href="/parteneri/${f.partener_id}">${esc(f.client)}</a>`,
    esc(f.scadenta || "—"),
    `<span class="badge ${BADGE[f.stare]}">${f.zile > 0 ? `+${f.zile} zile` : f.zile === 0 ? "azi" : `în ${-f.zile} zile`}</span>`,
    money(f.sold),
    comutator,
    `<form method="post" action="/scadente/${f.id}/trimite" class="inline-form"><button class="btn small secondary" type="submit">Trimite acum</button></form>`,
    f.ultima_notificare ? esc(String(f.ultima_notificare).slice(0, 10)) : "—",
  ];
}

async function blocScadente(user, agentId) {
  porneste(); // rutina zilnică, în fundal
  const facturi = await facturiCuSold(agentId);
  const stari = stariDinFacturi(facturi);
  const neverificate = facturi.filter((f) => f.neverificat).sort((a, b) => b.sold - a.sold);
  const cunoscute = facturi.filter((f) => !f.neverificat);
  const restante = cunoscute.filter((f) => f.zile > 0).sort((a, b) => b.zile - a.zile);
  const urmeaza = cunoscute.filter((f) => f.zile <= 0).sort((a, b) => a.zile - b.zile);
  const deLa = await dataStart();
  const capete = ["Factura", "Client", "Scadență", "Stare", "Sold", "Notificare", "Manual", "Ultima notificare"];

  const clientiRosii = [...stari.values()].filter((c) => c.stare === "rosu");
  const avertisment = clientiRosii.length
    ? `<p style="margin:6px 0 12px;font-size:13px">
         <span class="badge rosu">${clientiRosii.length} clienți blocați</span>
         Pentru ei nu se pot plasa comenzi noi până la stingerea restanței:
         ${clientiRosii.slice(0, 8).map((c) => `<a href="/parteneri/${c.partener_id}">${esc(c.nume)}</a>`).join(", ")}${clientiRosii.length > 8 ? " …" : ""}
       </p>`
    : "";

  return `
    <h2>Scadențe și încasări <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— o săptămână întârziere e galben, mai mult e roșu</span></h2>
    ${avertisment}
    <h3 style="margin-top:14px">Restanțe (${restante.length}) — total ${money(restante.reduce((s, f) => s + f.sold, 0))}</h3>
    ${
      restante.length
        ? table(capete, restante.slice(0, 120).map((f) => randFactura(f, stari.get(f.partener_id), user)))
        : `<p style="color:var(--text-muted)">Nicio factură restantă. </p>`
    }
    <h3 style="margin-top:18px">Urmează la încasare (${urmeaza.length})</h3>
    ${
      urmeaza.length
        ? table(capete, urmeaza.slice(0, 60).map((f) => randFactura(f, stari.get(f.partener_id), user)))
        : `<p style="color:var(--text-muted)">Nimic de încasat în perioada următoare.</p>`
    }
    ${
      neverificate.length
        ? `<h3 style="margin-top:22px">Sold vechi, neconfirmat (${neverificate.length}) — total ${money(neverificate.reduce((s, f) => s + f.sold, 0))}</h3>
           <p style="font-size:13px;color:var(--text-muted);max-width:780px">
             Facturi emise înainte de <strong>${esc(deLa || "—")}</strong>, data de la care e activ scadențarul.
             Din SmartBill au venit 3.000 de facturi și doar 1.400 de încasări, deci multe dintre astea apar
             neîncasate pentru că plata lor n-a fost importată, nu pentru că n-ar fi fost plătită.
             <strong>Nu generează notificări automate și nu blochează comenzi.</strong>
             Se pot notifica manual, una câte una, după ce verifici soldul. Când ai încredere în date,
             adminul poate muta data de start înapoi și intră și ele în regimul normal.
           </p>
           ${table(capete, neverificate.slice(0, 60).map((f) => randFactura(f, stari.get(f.partener_id), user)))}`
        : ""
    }
    <p style="font-size:12px;color:var(--text-muted);margin-top:8px">
      „Automat" înseamnă un email zilnic, adaptat la vechimea restanței, până la încasare. Facturile cu scadență
      în următoarele ${ZILE_PREAVIZ} zile primesc un mesaj politicos de reamintire. La peste 3 luni de restanță
      notificările devin obligatoriu automate și doar administratorul le mai poate opri.
    </p>`;
}

function register(router) {
  router.get("/scadente", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const agentId = eAdmin ? (ctx.query.agent ? parseInt(ctx.query.agent, 10) : null) : ctx.user.id;
    const agenti = eAdmin
      ? await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin') ORDER BY nume").all()
      : [];

    const bloc = await blocScadente(ctx.user, agentId);
    const body = `
      ${subnavCrm("/scadente", ctx.user)}
      ${
        eAdmin
          ? `<form method="get" action="/scadente" class="filtre">
              <span style="font-size:13px">Portofoliul lui:</span>
              <select name="agent" onchange="this.form.submit()">
                <option value="">toți</option>
                ${agenti.map((a) => `<option value="${a.id}"${String(a.id) === String(ctx.query.agent || "") ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
              </select>
              <span style="flex:1"></span>
            </form>
            <form method="post" action="/scadente/ruleaza" class="inline-form" style="margin-bottom:10px">
              <button class="btn secondary" type="submit">Rulează acum notificările automate</button>
            </form>
            <form method="post" action="/scadente/start" class="inline-form" style="margin-bottom:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:13px">Scadențarul e activ pentru facturi emise de la:</span>
              <input type="date" name="de_la" value="${esc(await dataStart())}">
              <button class="btn secondary small" type="submit">Salvează</button>
              <span style="font-size:12px;color:var(--text-muted)">Facturile mai vechi rămân vizibile, dar nu trimit notificări automate și nu blochează comenzi.</span>
            </form>`
          : ""
      }
      ${ctx.query.trimise ? `<p style="color:var(--success)">S-au trimis ${esc(ctx.query.trimise)} notificări automate${ctx.query.esuate && ctx.query.esuate !== "0" ? `, ${esc(ctx.query.esuate)} au eșuat` : ""}.</p>` : ""}
      ${ctx.query.eroare ? `<p style="color:var(--danger)">${esc(ctx.query.eroare)}</p>` : ""}
      ${bloc}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Scadențe", active: "/crm", body }));
  });

  // Bifa de notificare automată pe o factură.
  router.post("/scadente/:id/auto", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const f = await db.prepare("SELECT f.*, p.notificari_oprite FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?").get(ctx.params.id);
    if (!f) return redirect(ctx.res, "/scadente");
    const st = await stareClient(f.partener_id);
    // Agentul nu poate umbla la clienții intrați în regim obligatoriu.
    if (ctx.user.rol !== "admin" && (st.blocatAutomat || Number(f.notificari_oprite) === 1)) {
      return redirect(ctx.res, "/scadente?eroare=" + encodeURIComponent("Clientul e în regim automat obligatoriu — doar administratorul poate schimba notificările."));
    }
    const valoare = String(ctx.body.valoare) === "1" ? 1 : 0;
    await db.prepare("UPDATE facturi SET notificare_auto = ? WHERE id = ?").run(valoare, f.id);
    redirect(ctx.res, ctx.body.inapoi ? String(ctx.body.inapoi) : "/scadente");
  });

  // Trimitere manuală, acum.
  router.post("/scadente/:id/trimite", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const toate = await facturiCuSold(ctx.user.rol === "admin" ? null : ctx.user.id);
    const f = toate.find((x) => String(x.id) === String(ctx.params.id));
    if (!f) return redirect(ctx.res, "/scadente");
    const r = await trimiteNotificare(f, ctx.user, false);
    const dest = ctx.body.inapoi ? String(ctx.body.inapoi) : "/scadente";
    redirect(ctx.res, r.status === "trimis" ? `${dest}${dest.includes("?") ? "&" : "?"}trimise=1&esuate=0` : `${dest}${dest.includes("?") ? "&" : "?"}eroare=${encodeURIComponent(r.eroare || "Nu s-a putut trimite.")}`);
  });

  // Data de la care scadențarul e activ (admin).
  router.post("/scadente/start", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/scadente");
    const v = await setDataStart(ctx.body.de_la);
    redirect(ctx.res, v ? "/scadente" : "/scadente?eroare=" + encodeURIComponent("Data nu e validă."));
  });

  // Rulaj manual al rutinei automate (admin).
  router.post("/scadente/ruleaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/scadente");
    const r = await ruleazaNotificariAutomate();
    redirect(ctx.res, `/scadente?trimise=${r.trimise}&esuate=${r.esuate}`);
  });

  // Adminul poate tăia de tot notificările pe un client (client în insolvență,
  // înțelegere separată, ce-o fi).
  router.post("/parteneri/:id/notificari", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `/parteneri/${ctx.params.id}`);
    const valoare = String(ctx.body.oprite) === "1" ? 1 : 0;
    await db.prepare("UPDATE parteneri SET notificari_oprite = ? WHERE id = ?").run(valoare, ctx.params.id);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });
}

module.exports = {
  register,
  blocScadente,
  porneste,
  dataStart,
  setDataStart,
  facturiCuSold,
  stariDinFacturi,
  stareClient,
  poateComanda,
  ruleazaNotificariAutomate,
  compuneMesaj,
  culoare,
  ZILE_GALBEN,
  ZILE_BLOCARE_TOTALA,
  ZILE_PREAVIZ,
};
