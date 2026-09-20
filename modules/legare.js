"use strict";
// Legarea emailurilor de firme — partea care face restul să funcționeze.
//
// MĂSURAT PE DATE REALE, înainte de modulul ăsta: din 1.805 mesaje intrate în
// ERP, 1.789 erau „de atribuit". Adică 99%. Tot ce s-a construit deasupra —
// semnături → contacte, cereri → taskuri, comenzi → ciorne, oferte →
// Procurement — lucra pe 16 mesaje, fiindcă toate cer un partener legat.
//
// De ce nu mergea: fișa partenerului are UN singur câmp de email, de obicei
// gol sau adresa de facturare. Oamenii scriu de pe adresele lor —
// comercial@euroink.it, andreea.cernea@aectra.ro, bianca@apacargo.ro. Nici
// potrivirea pe adresă, nici cea pe domeniu n-aveau de unde să nimerească.
//
// Ce face modulul ăsta, în ordinea încrederii:
//
//   1. ÎNVAȚĂ DIN CLICURI. Când cineva atribuie un mesaj unui partener,
//      domeniul expeditorului rămâne legat de acel partener, și toate
//      mesajele de pe el — vechi și viitoare — se leagă singure. Un clic per
//      furnizor, o dată în viață. Asta e sursa cea mai de încredere: a
//      hotărât un om, uitându-se la mesaj.
//   2. CITEȘTE FIȘELE. Domeniul din emailul partenerului, unde există. Dacă
//      două firme împart același domeniu, domeniul se lasă deoparte și se
//      arată în pagină — mai bine nelegat decât legat la firma greșită.
//   3. PROPUNE DUPĂ NUME. „euroink.it" seamănă cu „EUROINK DISTRIBUTION".
//      Asta NU se aplică niciodată singură. Se propune într-o listă, cu câte
//      mesaje atârnă de fiecare, și se confirmă cu un clic.
//
// Domeniile publice (gmail, yahoo) nu se leagă niciodată de nimeni: acolo
// domeniul nu spune nimic despre firmă. Nici domeniul nostru — un mesaj de la
// un coleg nu e un mesaj de la un client.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const DOMENII_PUBLICE = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ro", "yahoo.co.uk", "hotmail.com",
  "hotmail.ro", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com",
  "protonmail.com", "proton.me", "aol.com", "gmx.com", "gmx.net", "mail.ru", "yandex.ru",
]);

const DOMENIUL_NOSTRU = "cashmachine.ro";

const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function domeniulDin(email) {
  const a = String(email || "").toLowerCase().trim();
  const i = a.lastIndexOf("@");
  const d = i > 0 ? a.slice(i + 1) : a;
  return d.replace(/^www\./, "").replace(/[^a-z0-9.\-]/g, "");
}

function eFolositor(domeniu) {
  const d = String(domeniu || "").toLowerCase();
  if (!d || !d.includes(".")) return false;
  if (DOMENII_PUBLICE.has(d)) return false;
  if (d === DOMENIUL_NOSTRU || d.endsWith("." + DOMENIUL_NOSTRU)) return false;
  return true;
}

// Miezul unui domeniu: partea care seamănă cu numele firmei.
// „mail.euroink.it" → „euroink", „apacargo.ro" → „apacargo".
// Se taie sufixele publice compuse („co.uk", „com.tr") înainte de a lua
// ultima etichetă rămasă.
const SUFIXE = new Set([
  "ro", "com", "net", "org", "eu", "it", "hu", "gr", "de", "at", "fr", "es", "pl",
  "bg", "tr", "uk", "nl", "be", "cz", "sk", "si", "hr", "rs", "md", "ua", "us",
  "info", "biz", "online", "shop", "store", "group", "io", "co",
]);

function nucleu(domeniu) {
  const parti = String(domeniu || "").toLowerCase().split(".").filter(Boolean);
  while (parti.length > 1 && SUFIXE.has(parti[parti.length - 1])) parti.pop();
  return parti.length ? parti[parti.length - 1] : "";
}

// Numele firmei, adus la o formă comparabilă cu miezul unui domeniu:
// fără diacritice, fără formă juridică, fără spații și punctuație.
const FORMA_JURIDICA = /\b(s\.?\s?r\.?\s?l\.?|s\.?\s?a\.?|p\.?f\.?a\.?|i\.?i\.?|srl|sa|inc|ltd|llc|gmbh|bv|nv|ag|spa|kft|zrt|doo|d\.?o\.?o\.?)\b/gi;

function numeStrans(nume) {
  return String(nume || "")
    .toLowerCase()
    .replace(/[ăâ]/g, "a").replace(/î/g, "i").replace(/[șş]/g, "s").replace(/[țţ]/g, "t")
    .replace(FORMA_JURIDICA, " ")
    .replace(/[^a-z0-9]+/g, "");
}

// ---- harta ------------------------------------------------------------------

// Domeniile pe care le știm sigur: învățate din clicuri, plus cele din fișele
// partenerilor. Un domeniu revendicat de două firme nu se leagă de niciuna.
async function hartaDomenii() {
  const harta = new Map();
  const ambigue = new Set();

  // 2. fișele partenerilor — se pun primele, ca să fie suprascrise de ce a zis un om
  const parteneri = await db
    .prepare("SELECT id, nume, email FROM parteneri WHERE COALESCE(email,'') <> ''")
    .all()
    .catch(() => []);
  for (const p of parteneri) {
    for (const bucata of String(p.email).split(/[;,\s]+/)) {
      const d = domeniulDin(bucata);
      if (!eFolositor(d)) continue;
      if (harta.has(d) && harta.get(d).partener_id !== p.id) {
        ambigue.add(d);
        harta.delete(d);
        continue;
      }
      if (!ambigue.has(d)) harta.set(d, { partener_id: p.id, sursa: "fisa", nume: p.nume });
    }
  }

  // 1. ce a hotărât un om bate orice deducere
  const invatate = await db
    .prepare(
      `SELECT d.domeniu, d.partener_id, d.sursa, p.nume
         FROM email_domenii d JOIN parteneri p ON p.id = d.partener_id
        ORDER BY d.id`
    )
    .all()
    .catch(() => []);
  for (const d of invatate) {
    const dom = String(d.domeniu || "").toLowerCase();
    if (!eFolositor(dom)) continue;
    harta.set(dom, { partener_id: Number(d.partener_id), sursa: d.sursa || "om", nume: d.nume });
  }

  return { harta, ambigue };
}

// Ține minte: domeniul ăsta e al partenerului ăsta.
async function tineMinte(domeniu, partenerId, utilizatorId, sursa) {
  const d = String(domeniu || "").toLowerCase();
  if (!eFolositor(d) || !partenerId) return false;
  const existent = await db.prepare("SELECT id FROM email_domenii WHERE lower(domeniu) = lower(?)").get(d).catch(() => null);
  if (existent) {
    await db
      .prepare("UPDATE email_domenii SET partener_id = ?, sursa = ?, pus_de = ?, creat_la = ? WHERE id = ?")
      .run(partenerId, sursa || "om", utilizatorId || null, acum(), existent.id);
  } else {
    await db
      .prepare("INSERT INTO email_domenii (domeniu, partener_id, sursa, pus_de) VALUES (?, ?, ?, ?)")
      .run(d, partenerId, sursa || "om", utilizatorId || null);
  }
  return true;
}

// ---- legarea în masă --------------------------------------------------------

// Leagă toate mesajele nelegate de pe domeniile pe care le știm.
// Nu atinge niciodată un mesaj deja legat: dacă un om l-a pus altundeva,
// el știe mai bine.
async function releagaTot() {
  const { harta, ambigue } = await hartaDomenii();
  let legate = 0;
  const peDomeniu = [];

  for (const [dom, info] of harta) {
    const n = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM email_mesaje WHERE activ = 1 AND partener_id IS NULL AND lower(COALESCE(de_la_domeniu,'')) = ?"
      )
      .get(dom)
      .catch(() => ({ n: 0 }));
    const cate = Number((n && n.n) || 0);
    if (!cate) continue;
    await db
      .prepare(
        "UPDATE email_mesaje SET partener_id = ?, legat_cum = ? WHERE activ = 1 AND partener_id IS NULL AND lower(COALESCE(de_la_domeniu,'')) = ?"
      )
      .run(info.partener_id, "domeniul " + dom, dom);
    legate += cate;
    peDomeniu.push({ domeniu: dom, partener: info.nume, sursa: info.sursa, mesaje: cate });
  }

  peDomeniu.sort((a, b) => b.mesaje - a.mesaje);
  return { legate, domenii: peDomeniu.length, ambigue: [...ambigue], peDomeniu: peDomeniu.slice(0, 50) };
}

// Ce partener are domeniul ăsta, dacă știm. Folosit la legarea unui mesaj nou.
async function dinDomeniu(domeniu) {
  const d = String(domeniu || "").toLowerCase();
  if (!eFolositor(d)) return null;
  const r = await db
    .prepare("SELECT partener_id FROM email_domenii WHERE lower(domeniu) = lower(?) LIMIT 1")
    .get(d)
    .catch(() => null);
  if (r && r.partener_id) return Number(r.partener_id);
  const p = await db
    .prepare("SELECT id FROM parteneri WHERE lower(email) LIKE lower(?) ORDER BY id LIMIT 1")
    .get("%@" + d)
    .catch(() => null);
  return p ? Number(p.id) : null;
}

// ---- propunerile după nume --------------------------------------------------

// Domeniile de pe care ne scrie lume, pe care încă nu le știm, cu firma care
// seamănă cel mai bine cu ele. Se propun, nu se aplică.
async function sugestii({ minim } = {}) {
  const { harta } = await hartaDomenii();
  const prag = Number.isFinite(minim) ? minim : 1;

  const domenii = await db
    .prepare(
      `SELECT lower(de_la_domeniu) AS domeniu, COUNT(*) AS mesaje,
              MIN(de_la) AS exemplu, MAX(de_la_nume) AS nume_exemplu, MAX(data) AS ultimul
         FROM email_mesaje
        WHERE activ = 1 AND partener_id IS NULL AND COALESCE(de_la_domeniu,'') <> ''
        GROUP BY 1
       HAVING COUNT(*) >= ${prag}
        ORDER BY COUNT(*) DESC
        LIMIT 400`
    )
    .all()
    .catch(() => []);

  const parteneri = await db.prepare("SELECT id, nume, tip FROM parteneri ORDER BY id").all().catch(() => []);
  const cuNume = parteneri.map((p) => ({ ...p, strans: numeStrans(p.nume) })).filter((p) => p.strans.length >= 4);

  const out = [];
  for (const d of domenii) {
    if (!eFolositor(d.domeniu) || harta.has(d.domeniu)) continue;
    const n = nucleu(d.domeniu);
    // Miezuri prea scurte („apa", „ctp") se potrivesc pe orice. Nu le propunem.
    if (n.length < 5) {
      out.push({ ...d, nucleu: n, propus: null, motiv: "miez prea scurt" });
      continue;
    }
    let cel = null;
    // Câte firme se potrivesc EXACT pe miezul domeniului. Contează, pentru că
    // la egalitate bucla de mai jos o ține pe prima găsită și tace: la „aquila"
    // sunt șapte fișe Aquila în bază, iar o alegere făcută pe tăcute între ele
    // e mai rea decât niciuna. Când sunt mai multe, propunerea nu se aplică în
    // masă — rămâne de ales de un om.
    let egali = 0;
    for (const p of cuNume) {
      if (p.strans === n) egali++;
      if (!p.strans.includes(n) && !n.includes(p.strans)) continue;
      // Cu cât potrivirea acoperă mai mult din numele firmei, cu atât e mai bună.
      const scor = Math.min(n.length, p.strans.length) / Math.max(n.length, p.strans.length);
      if (!cel || scor > cel.scor) cel = { partener: p, scor };
    }
    out.push({
      ...d,
      nucleu: n,
      propus: cel ? cel.partener : null,
      scor: cel ? Math.round(cel.scor * 100) : 0,
      egali,
      sigur: !!cel && cel.scor === 1 && egali === 1,
      motiv: cel ? "" : "nicio firmă cu nume asemănător",
    });
  }
  return out;
}

// ---- pagina -----------------------------------------------------------------

function register(router) {
  router.get("/email/domenii", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");

    const total = await db.prepare("SELECT COUNT(*) AS n FROM email_mesaje WHERE activ = 1").get().catch(() => ({ n: 0 }));
    const fara = await db
      .prepare("SELECT COUNT(*) AS n FROM email_mesaje WHERE activ = 1 AND partener_id IS NULL")
      .get()
      .catch(() => ({ n: 0 }));
    const { harta, ambigue } = await hartaDomenii();
    const props = await sugestii({ minim: 1 });
    const cuPropunere = props.filter((p) => p.propus);
    const faraPropunere = props.filter((p) => !p.propus);
    const sigure = cuPropunere.filter((p) => p.sigur);
    const mesajeSigure = sigure.reduce((s, p) => s + Number(p.mesaje || 0), 0);

    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 5000").all().catch(() => []);

    // Lista de firme se trimite O SINGURĂ DATĂ, ca date, și se toarnă în
    // select abia când omul dă clic pe el.
    //
    // De ce: prima variantă scria toate cele ~1.500 de firme în fiecare din
    // cele 120 de rânduri. Pagina ieșea de 2,7 MB, se încărca în zeci de
    // secunde, iar butonul „Leagă tot" de sus nu se mai putea apăsa —
    // funcția exista, dar nimeni n-ajungea la ea. Un buton pe care nu poți
    // apăsa e ca și cum n-ar fi scris.
    const firmeJson = JSON.stringify(parteneri.map((p) => [Number(p.id), String(p.nume)]));
    const selectGol = (ales) =>
      `<option value="">— alege firma —</option>` +
      (ales ? `<option value="${Number(ales)}" selected>${esc((parteneri.find((p) => Number(p.id) === Number(ales)) || {}).nume || "")}</option>` : "");

    const nLegate = Number(total.n || 0) - Number(fara.n || 0);
    const procent = Number(total.n) ? Math.round((nLegate / Number(total.n)) * 100) : 0;

    const body = `
      ${
        ctx.query.sigure
          ? `<div class="card" style="border-left:4px solid var(--ok,#1e7a45);margin-bottom:12px;max-width:880px">
               Am confirmat <strong>${Number(ctx.query.sigure || 0)}</strong> domenii și am legat
               <strong>${Number(ctx.query.legate || 0).toLocaleString("ro-RO")}</strong> de mesaje.
               De acum, orice mesaj nou de pe domeniile alea se leagă singur.
             </div>`
          : ""
      }
      <p style="color:var(--text-muted);font-size:13px;max-width:880px">
        Un email se leagă de o firmă după <strong>domeniul expeditorului</strong>. Domeniile se învață:
        când cineva atribuie un mesaj unui partener, domeniul rămâne legat de el, iar toate mesajele de pe
        domeniul ăla — vechi și viitoare — se leagă singure. Mai jos sunt domeniile de pe care ne scrie lume
        și pe care încă nu le știm, cu firma care seamănă cel mai bine. <strong>Nimic nu se aplică singur</strong>
        de aici: confirmi tu, o dată per firmă.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Mesaje în ERP</div><div class="value">${Number(total.n || 0).toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Legate de o firmă</div><div class="value">${nLegate.toLocaleString("ro-RO")} <span style="font-size:14px;color:var(--text-muted)">(${procent}%)</span></div></div>
        <div class="card"><div class="label">Domenii știute</div><div class="value">${harta.size}</div></div>
        <div class="card"><div class="label">De confirmat</div><div class="value">${cuPropunere.length}</div></div>
      </div>

      <form method="post" action="/email/domenii/releaga" class="inline-form" style="margin:14px 0">
        <button class="btn secondary" type="submit">Leagă tot ce se poate acum</button>
        <span style="font-size:12px;color:var(--text-muted)">
          Folosește doar domeniile deja știute. Nu atinge mesajele legate deja de cineva.
        </span>
      </form>

      ${
        sigure.length
          ? `<form method="post" action="/email/domenii/confirma-sigure" class="inline-form" style="margin:14px 0"
                   onsubmit="return confirm('Confirm cele ${sigure.length} domenii și leg ${mesajeSigure} de mesaje?')">
               <button class="btn" type="submit">Confirmă cele ${sigure.length} potriviri sigure (${mesajeSigure.toLocaleString("ro-RO")} mesaje)</button>
               <span style="font-size:12px;color:var(--text-muted)">
                 Doar unde miezul domeniului e identic, literă cu literă, cu numele firmei — ȘI unde o singură
                 firmă se potrivește așa. Restul rămân de confirmat unul câte unul, mai jos.
               </span>
             </form>`
          : ""
      }

      ${
        ambigue.size
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:880px;margin-bottom:14px">
               <strong>${ambigue.size} domenii revendicate de două firme</strong> — nu le leg de niciuna,
               ca să nu nimeresc greșit: ${esc([...ambigue].slice(0, 12).join(", "))}. Alege firma mai jos dacă vrei.
             </div>`
          : ""
      }

      <h2>Domenii de confirmat (${cuPropunere.length})</h2>
      ${
        cuPropunere.length
          ? table(
              ["Domeniu", "Mesaje", "Cine scrie de acolo", "Firma propusă", "Potrivire", ""],
              cuPropunere.map((d) => [
                `<strong>${esc(d.domeniu)}</strong>`,
                String(d.mesaje),
                esc(d.nume_exemplu || d.exemplu || ""),
                `<select name="x" disabled style="max-width:280px"><option>${esc(d.propus.nume)}</option></select>`,
                d.sigur
                  ? '<span class="badge verde">sigur</span>'
                  : d.egali > 1
                  ? `<span class="badge rosu" title="${d.egali} firme se potrivesc la fel de bine">${d.scor}% · ${d.egali} firme la fel</span>`
                  : `${d.scor}%`,
                `<form method="post" action="/email/domenii/confirma" class="inline-form">
                   <input type="hidden" name="domeniu" value="${esc(d.domeniu)}">
                   <input type="hidden" name="partener_id" value="${d.propus.id}">
                   <button class="btn small" type="submit">Confirmă</button>
                 </form>`,
              ])
            )
          : "<p>Nimic de confirmat.</p>"
      }

      <h2>Domenii fără propunere (${faraPropunere.length})</h2>
      <p style="font-size:13px;color:var(--text-muted)">
        Aici numele firmei nu seamănă cu domeniul, sau firma nu e în ERP. Alegi tu, sau le lași —
        multe sunt newslettere și roboți, care n-au ce căuta legați de nimeni.
      </p>
      ${
        faraPropunere.length
          ? table(
              ["Domeniu", "Mesaje", "Cine scrie de acolo", "Ultimul", "Leagă de"],
              faraPropunere.slice(0, 120).map((d) => [
                `<strong>${esc(d.domeniu)}</strong>`,
                String(d.mesaje),
                esc(d.nume_exemplu || d.exemplu || ""),
                esc(String(d.ultimul || "").slice(0, 10)),
                `<form method="post" action="/email/domenii/confirma" class="inline-form" style="gap:6px">
                   <input type="hidden" name="domeniu" value="${esc(d.domeniu)}">
                   <select name="partener_id" class="alege-firma" style="max-width:240px">${selectGol(null)}</select>
                   <button class="btn small secondary" type="submit">Leagă</button>
                 </form>`,
              ])
            )
          : "<p>Niciunul.</p>"
      }

      <script>
        // Firmele, o dată. Fiecare select se umple la primul clic pe el.
        (function () {
          var FIRME = ${firmeJson};
          function umple(sel) {
            if (sel.dataset.pline) return;
            sel.dataset.pline = "1";
            var ales = sel.value;
            var buc = ['<option value="">— alege firma —</option>'];
            for (var i = 0; i < FIRME.length; i++) {
              buc.push('<option value="' + FIRME[i][0] + '">' +
                String(FIRME[i][1]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</option>");
            }
            sel.innerHTML = buc.join("");
            if (ales) sel.value = ales;
          }
          document.addEventListener("mousedown", function (e) {
            var s = e.target.closest ? e.target.closest("select.alege-firma") : null;
            if (s) umple(s);
          }, true);
          document.addEventListener("focusin", function (e) {
            if (e.target && e.target.classList && e.target.classList.contains("alege-firma")) umple(e.target);
          });
          // Dacă cineva trimite formularul fără să fi deschis lista, selectul
          // e gol și n-are ce trimite — nu se pierde nimic, doar nu se leagă.
        })();
      </script>`;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Domeniile care leagă emailurile de firme", active: "/email", body }));
  });

  router.post("/email/domenii/confirma", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const dom = String((ctx.body || {}).domeniu || "").toLowerCase();
    const pid = parseInt((ctx.body || {}).partener_id, 10);
    if (dom && pid) {
      await tineMinte(dom, pid, ctx.user.id, "nume");
      // Se aplică imediat: omul tocmai a confirmat, n-are rost să mai aștepte.
      await db
        .prepare(
          "UPDATE email_mesaje SET partener_id = ?, legat_cum = ? WHERE activ = 1 AND partener_id IS NULL AND lower(COALESCE(de_la_domeniu,'')) = ?"
        )
        .run(pid, "domeniul " + dom, dom);
    }
    redirect(ctx.res, "/email/domenii");
  });

  router.post("/email/domenii/releaga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    await releagaTot();
    redirect(ctx.res, "/email/domenii");
  });

  // Confirmă dintr-o apăsare doar potrivirile care nu lasă loc de interpretare.
  //
  // „Sigur" înseamnă două lucruri deodată, și amândouă contează:
  //   1. miezul domeniului e IDENTIC cu numele firmei strâns — nu „seamănă",
  //      nu „conține", ci literă cu literă: warehouseall.ro ↔ WAREHOUSE ALL SRL;
  //   2. o SINGURĂ firmă din bază se potrivește așa. Unde sunt mai multe —
  //      cele șapte fișe Aquila — nu se alege nimic automat, fiindcă alegerea
  //      s-ar face pe tăcute, după ordinea din bază, și nimeni n-ar ști de ce
  //      emailurile au ajuns la fișa greșită.
  //
  // Lista se recalculează aici, nu se primește din formular: butonul și
  // tabelul trebuie să vadă exact aceleași rânduri.
  router.post("/email/domenii/confirma-sigure", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const props = await sugestii({ minim: 1 });
    let domenii = 0;
    let legate = 0;
    for (const d of props) {
      if (!d.sigur || !d.propus) continue;
      await tineMinte(d.domeniu, d.propus.id, ctx.user.id, "nume-exact");
      const r = await db
        .prepare(
          "UPDATE email_mesaje SET partener_id = ?, legat_cum = ? WHERE activ = 1 AND partener_id IS NULL AND lower(COALESCE(de_la_domeniu,'')) = ?"
        )
        .run(d.propus.id, "domeniul " + d.domeniu, d.domeniu);
      domenii++;
      legate += Number(d.mesaje || 0);
      void r;
    }
    redirect(ctx.res, `/email/domenii?sigure=${domenii}&legate=${legate}`);
  });
}

module.exports = {
  register,
  hartaDomenii,
  releagaTot,
  dinDomeniu,
  tineMinte,
  sugestii,
  domeniulDin,
  eFolositor,
  nucleu,
  numeStrans,
};
