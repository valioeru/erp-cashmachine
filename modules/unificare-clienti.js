"use strict";
// Configurări · Unificare clienți.
//
// CEREREA LUI VALI, 26.11.2026: „Fă te rog și pagina de unificare […] care să
// fie validată manual, cu sugestie, ca la produse. Vreau unificare pe clienți."
//
// CE FACE PAGINA:
//   1. „Propuneri": perechile de parteneri care par același — același CUI,
//      același nume (fără SRL/SA), același email sau telefon, nume scrise
//      aproape la fel. La fiecare: „Vezi și unifică" (întâi se vede ce se
//      mută și pe care îl păstrăm) sau „Nu e același client" (nu se mai propune).
//   2. „Alege tu doi parteneri": pentru o pereche pe care ERP-ul n-a ghicit-o.
//   3. „Unificări făcute": urma fiecăreia, cu „Desfă".
//
// PAGINA NU UNIFICĂ NIMIC SINGURĂ. Propune; validarea e a omului, pereche cu
// pereche. Socoteala (cine cu cine seamănă) e în lib/unificare-clienti.js, fără
// bază; mutarea o face lib/parteneri-fuziune.js, într-o singură instrucțiune.
const db = require("../lib/db");
const { esc, layout } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const UC = require("../lib/unificare-clienti");
const PF = require("../lib/parteneri-fuziune");

const CALE = "/configurari/unificare-clienti";
const TIP = { client: "client", furnizor: "furnizor", ambele: "client și furnizor" };
const STARE = { lead: "lead / prospect", client_activ: "client activ", client_inactiv: "client inactiv", furnizor_activ: "furnizor activ" };
const ETICHETE_CAMP = {
  cui: "CUI", reg_com: "Nr. Reg. Com.", email: "email", telefon: "telefon", persoana_contact: "persoana de contact", adresa: "adresa",
  localitate: "localitatea", judet: "județul", tara: "țara", termen_plata_zile: "termenul de plată", agent_id: "agentul", firma_grup_id: "firma din grup",
  data_nastere: "data nașterii", sursa: "sursa", tip: "tipul", stare: "starea",
};

const idDin = (v) => {
  const n = parseInt(String(v == null ? "" : v).replace(/^#/, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const dataRo = (v) => {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
};

function subnav(activ) {
  // Aceleași legături ca în modules/configurari.js, cod-produs.js și unificare-coduri.js.
  const linkuri = [
    ["/configurari/date", "Date importate"],
    ["/configurari/storno", "Facturi stornate"],
    ["/configurari/adrese", "Adrese de anunț"],
    ["/configurari/ignorati", "Parteneri ignorați"],
    ["/configurari/cod-produs", "Codul produsului"],
    ["/configurari/unificare-coduri", "Unificare coduri"],
    [CALE, "Unificare clienți"],
  ];
  return `<div class="subnav">${linkuri.map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`).join("")}</div>`;
}

// Partenerii în joc (fără cei ignorați), cu ce documente au, și ce a hotărât
// deja un om.
async function citeste() {
  const parteneri = await db
    .prepare(
      `SELECT p.id, p.tip, p.nume, p.cui, p.email, p.telefon, p.adresa, p.localitate, p.judet, p.persoana_contact, p.stare, p.sursa,
              p.agent_id, u.nume AS agent_nume
         FROM parteneri p LEFT JOIN utilizatori u ON u.id = p.agent_id
        WHERE COALESCE(p.ignorat, 0) = 0
        ORDER BY p.id`
    )
    .all();
  const numar = async (sql) => new Map((await db.prepare(sql).all().catch(() => [])).map((r) => [Number(r.id), r]));
  const comenzi = await numar("SELECT partener_id AS id, COUNT(*) AS n, MAX(LEFT(data::text, 10)) AS ultima FROM comenzi GROUP BY partener_id");
  const facturi = await numar("SELECT partener_id AS id, COUNT(*) AS n, MAX(LEFT(data_emiterii::text, 10)) AS ultima FROM facturi WHERE COALESCE(activ, 1) = 1 GROUP BY partener_id");
  const respinse = new Set(
    (await db.prepare("SELECT a_id, b_id FROM parteneri_unificare_respinse").all().catch(() => [])).map((r) => UC.cheiePereche(r.a_id, r.b_id))
  );
  const fuziuni = await db
    .prepare(
      `SELECT f.id, f.pastrat_id, f.inghitit_id, f.inghitit_nume, f.inghitit_cui, f.mutari, f.facut_la, f.desfacut_la, u.nume AS facut_de, p.nume AS pastrat_nume
         FROM parteneri_fuziuni f LEFT JOIN utilizatori u ON u.id = f.facut_de LEFT JOIN parteneri p ON p.id = f.pastrat_id
        ORDER BY f.id DESC LIMIT 300`
    )
    .all()
    .catch(() => []);
  const documente = new Map();
  for (const p of parteneri) {
    const id = Number(p.id);
    documente.set(id, Number((comenzi.get(id) || {}).n || 0) + Number((facturi.get(id) || {}).n || 0));
  }
  return { parteneri, dupaId: new Map(parteneri.map((p) => [Number(p.id), p])), comenzi, facturi, respinse, fuziuni, documente };
}

function register(router) {
  const cartela = (d, p) => {
    const id = Number(p.id);
    const c = d.comenzi.get(id), f = d.facturi.get(id);
    const doc = [c ? `${c.n} ${Number(c.n) === 1 ? "comandă" : "comenzi"}` : "", f ? `${f.n} ${Number(f.n) === 1 ? "factură" : "facturi"}` : ""].filter(Boolean).join(" · ");
    const ultima = [c && c.ultima, f && f.ultima].filter(Boolean).sort().pop();
    return `<div><a href="/parteneri/${id}"><strong>${esc(p.nume || "#" + id)}</strong></a> <span style="color:var(--text-muted);font-size:12px">#${id} · ${esc(TIP[p.tip] || p.tip || "")}</span></div>
      <div style="font-size:12px;color:var(--text-muted)">${[
        p.cui ? "CUI " + esc(p.cui) : "fără CUI",
        esc([p.adresa, p.localitate].filter(Boolean).join(", ").slice(0, 70)),
        esc(p.email || ""),
        esc(p.telefon || ""),
        p.agent_nume ? "agent " + esc(p.agent_nume) : "",
      ].filter(Boolean).join(" · ")}</div>
      <div style="font-size:12px">${doc ? esc(doc) + (ultima ? ` <span style="color:var(--text-muted)">(ultima: ${dataRo(ultima)})</span>` : "") : '<span style="color:var(--text-muted)">fără comenzi sau facturi</span>'}</div>`;
  };

  router.get(CALE, async (ctx) => {
    const q = ctx.query || {};
    const d = await citeste();
    const cauta = String(q.q || "").trim().slice(0, 80);
    const ac = UC.cheieNume(cauta) || cauta.toLowerCase();
    const toate = UC.propuneri(d.parteneri, { respinse: d.respinse, fuziuni: d.fuziuni.filter((f) => !f.desfacut_la) });
    const propuneri = ac
      ? toate.filter((r) => [r.a, r.b].some((p) => UC.cheieNume(p.nume).includes(ac) || String(p.cui || "").toLowerCase().includes(cauta.toLowerCase())))
      : toate;
    const parte = String(q.parte || "") === "facute" ? "facute" : "propuneri";
    const facute = d.fuziuni;

    const mesaj =
      (q.ok ? `<div class="flash" role="status">${esc(String(q.ok))}</div>` : "") +
      (q.eroare ? `<div class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(q.eroare))}</div>` : "");
    const sigure = toate.filter((r) => r.scor >= 90).length;
    const carduri = `<div class="cards">
        <div class="card"><div class="label">Parteneri</div><div class="value">${d.parteneri.length}</div><div class="ct-sub">fără cei ignorați</div></div>
        <div class="card"><div class="label">Perechi propuse</div><div class="value">${toate.length}${toate.length >= UC.MAX_PROPUNERI ? "+" : ""}</div><div class="ct-sub">${sigure} cu același CUI sau același nume</div></div>
        <div class="card"><div class="label">Unificări făcute</div><div class="value">${facute.filter((f) => !f.desfacut_la).length}</div><div class="ct-sub">se pot desface</div></div>
      </div>`;
    const taburi = `<div class="subnav" style="margin:10px 0">
        <a href="${CALE}" class="subnav-link${parte === "propuneri" ? " activ" : ""}">Propuneri (${toate.length})</a>
        <a href="${CALE}?parte=facute" class="subnav-link${parte === "facute" ? " activ" : ""}">Unificări făcute (${facute.length})</a>
      </div>`;

    let continut;
    if (parte === "facute") {
      continut = facute.length
        ? `<table class="table" data-unificari-facute><thead><tr><th>Când</th><th>A intrat</th><th>În</th><th>Rânduri mutate</th><th>De</th><th></th></tr></thead><tbody>${facute
            .map((f) => {
              let total = 0;
              try { total = Object.values(JSON.parse(f.mutari || "{}")).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0); } catch (e) { total = 0; }
              return `<tr><td>${esc(String(f.facut_la || "").slice(0, 16))}</td>
                <td>${esc(f.inghitit_nume || "")} <span style="color:var(--text-muted);font-size:12px">#${f.inghitit_id}${f.inghitit_cui ? " · CUI " + esc(f.inghitit_cui) : ""}</span></td>
                <td>${f.pastrat_nume ? `<a href="/parteneri/${f.pastrat_id}">${esc(f.pastrat_nume)}</a>` : `#${f.pastrat_id}`}</td>
                <td>${total}</td><td>${esc(f.facut_de || "")}</td>
                <td>${
                  f.desfacut_la
                    ? `<span style="color:var(--text-muted)">desfăcută ${esc(dataRo(f.desfacut_la))}</span>`
                    : `<form method="post" action="${CALE}/desfa" style="display:inline" onsubmit="return confirm('Desfaci unificarea? Partenerul scos revine, iar rândurile mutate se întorc la el.')"><input type="hidden" name="fuziune_id" value="${f.id}"><button class="btn secondary small" type="submit">Desfă</button></form>`
                }</td></tr>`;
            })
            .join("")}</tbody></table>`
        : '<p style="color:var(--text-muted)">Nicio unificare făcută încă.</p>';
    } else {
      const randuri = propuneri
        .map((r) => {
          const pastrat = UC.alegePastrat(r.a, r.b, d.documente);
          const celalalt = Number(pastrat.id) === Number(r.a.id) ? r.b : r.a;
          return `<tr data-pereche="${r.a.id}:${r.b.id}">
            <td>${cartela(d, r.a)}</td>
            <td>${cartela(d, r.b)}</td>
            <td>${r.motive.map((m) => `<div>${esc(m)}</div>`).join("")}${r.atentie.map((m) => `<div style="color:#b42318;font-weight:600;font-size:12px">${esc(m)}</div>`).join("")}</td>
            <td style="white-space:nowrap">
              <a class="btn small" href="${CALE}/unifica?pastrat=${pastrat.id}&inghitit=${celalalt.id}">Vezi și unifică</a>
              <form method="post" action="${CALE}/respinge" style="display:inline"><input type="hidden" name="a_id" value="${r.a.id}"><input type="hidden" name="b_id" value="${r.b.id}"><button class="btn secondary small" type="submit">Nu e același client</button></form>
            </td></tr>`;
        })
        .join("");
      continut = `
        <form method="get" action="${CALE}" class="toolbar" style="margin:0 0 10px">
          <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după nume sau CUI" style="min-width:280px">
          <button class="btn secondary" type="submit">Caută</button>
          ${cauta ? `<a class="btn secondary small" href="${CALE}">Arată tot</a>` : ""}
        </form>
        ${
          propuneri.length
            ? `<table class="table" data-propuneri-clienti><thead><tr><th>Partener</th><th>Pare același cu</th><th>De ce</th><th></th></tr></thead><tbody>${randuri}</tbody></table>`
            : `<p style="color:var(--text-muted)">${cauta ? "Nicio propunere pentru căutarea asta." : "Nicio pereche de propus: nu am găsit parteneri care să pară scriși de două ori."}</p>`
        }
        <div class="detail-box" style="margin-top:16px;max-width:980px" data-alege-doi>
          <div style="font-weight:600;margin-bottom:6px">Alege tu doi parteneri</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Pentru o pereche pe care n-am ghicit-o. Scrie numele și alege din listă; întâi vezi ce se mută, apoi confirmi.</div>
          <form method="get" action="${CALE}/unifica" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
            <label style="font-weight:400;flex:1;min-width:240px">Rămâne<br><input type="text" name="pastrat" list="uc-parteneri" required placeholder="#id nume" style="width:100%" autocomplete="off"></label>
            <label style="font-weight:400;flex:1;min-width:240px">Intră în el (dispare din liste)<br><input type="text" name="inghitit" list="uc-parteneri" required placeholder="#id nume" style="width:100%" autocomplete="off"></label>
            <button class="btn secondary" type="submit">Vezi ce se mută</button>
          </form>
          <datalist id="uc-parteneri">${d.parteneri.slice().sort((x, y) => String(x.nume || "").localeCompare(String(y.nume || ""), "ro")).map((p) => `<option value="#${p.id} ${esc(p.nume || "")}${p.cui ? " · CUI " + esc(p.cui) : ""}">`).join("")}</datalist>
        </div>`;
    }

    send(
      ctx.res,
      200,
      layout({
        user: ctx.user,
        title: "Unificare clienți",
        active: "/configurari",
        body: `${subnav(CALE)}${mesaj}
          <p style="max-width:980px;color:var(--text-muted)">Același partener a ajuns în ERP de mai multe ori: din facturile SmartBill, scris de un agent la o comandă, dintr-un lead. Aici sunt perechile care par același partener. <strong>Nimic nu se unifică singur</strong>: te uiți la fiecare pereche, vezi ce se mută și confirmi. La unificare, comenzile, facturile, contactele și adresele trec pe partenerul păstrat, iar cel unificat dispare din liste. Orice unificare se poate desface.</p>
          ${carduri}${taburi}${continut}`,
      })
    );
  });

  // Previzualizarea: ce se mută și pe care îl păstrăm.
  router.get(`${CALE}/unifica`, async (ctx) => {
    const P = idDin(ctx.query.pastrat), O = idDin(ctx.query.inghitit);
    let v;
    try {
      v = await PF.previzualizeaza(P, O);
    } catch (e) {
      return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent(e.message)}`);
    }
    const d = await citeste();
    const pp = d.dupaId.get(P) || v.pastrat, po = d.dupaId.get(O) || v.inghitit;
    const cuiP = UC.cuiCurat(v.pastrat.cui), cuiO = UC.cuiCurat(v.inghitit.cui);
    const agenti = new Map((await db.prepare("SELECT id, nume FROM utilizatori").all().catch(() => [])).map((u) => [Number(u.id), u.nume]));
    const valoare = (c, x) => (c === "agent_id" ? agenti.get(Number(x)) || "#" + x : c === "tip" ? "client și furnizor" : c === "stare" ? STARE[x] || String(x) : String(x));
    const cutie = (titlu, p, culoare) => `<div class="detail-box" style="flex:1 1 340px;border-left:4px solid ${culoare}">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:4px">${titlu}</div>${cartela(d, p)}</div>`;
    const body = `
      ${subnav(CALE)}
      ${ctx.query.eroare ? `<div class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(ctx.query.eroare))}</div>` : ""}
      <div style="display:flex;gap:14px;flex-wrap:wrap;max-width:980px" data-previzualizare>
        ${cutie("Dispare din liste (intră în celălalt)", po, "#b42318")}
        ${cutie("Rămâne", pp, "#1a7f37")}
      </div>
      <p style="max-width:980px"><a class="btn secondary small" href="${CALE}/unifica?pastrat=${O}&inghitit=${P}">⇄ Păstrează-l pe celălalt</a></p>
      ${
        cuiP && cuiO && cuiP !== cuiO
          ? `<div class="flash flash-rosu" role="alert" style="max-width:980px;background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">Cei doi au CUI-uri diferite (${esc(cuiO)} și ${esc(cuiP)}): în acte sunt două firme diferite. După unificare, facturile amândurora vor sta pe „${esc(v.pastrat.nume)}”, cu CUI ${esc(cuiP)}. Unifică doar dacă ești sigur că e același partener.</div>`
          : ""
      }
      ${
        v.nestiute.length
          ? `<div class="flash flash-rosu" role="alert" style="max-width:980px;background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">Unificarea e oprită: în bază sunt legături spre parteneri pe care motorul nu le știe (${esc(v.nestiute.join(", "))}). Anunță-l pe Vali.</div>`
          : ""
      }
      <div class="detail-box" style="max-width:980px">
        <div style="font-weight:600;margin-bottom:6px">Ce trece pe „${esc(v.pastrat.nume)}”</div>
        ${
          v.randuri.length
            ? `<table class="table" data-ce-se-muta><tbody>${v.randuri.map((r) => `<tr><td>${esc(r.ce)}</td><td style="text-align:right">${r.n}</td></tr>`).join("")}
                <tr><td><strong>în total</strong></td><td style="text-align:right"><strong>${v.total}</strong></td></tr></tbody></table>`
            : '<div style="color:var(--text-muted)">„' + esc(v.inghitit.nume) + "” n-are niciun document sau contact legat de el. Dispare doar rândul lui.</div>"
        }
        ${v.note.map((n) => `<div style="font-size:13px;color:var(--text-muted);margin-top:6px">${esc(n)}</div>`).join("")}
        <div style="margin-top:10px;font-size:13px" data-completari>${
          Object.keys(v.completari).length
            ? "„" + esc(v.pastrat.nume) + "” primește ce-i lipsea: " + Object.keys(v.completari).map((c) => `${esc(ETICHETE_CAMP[c] || c)} <strong>${esc(valoare(c, v.completari[c]))}</strong>`).join(", ") + "."
            : "Partenerul păstrat are deja toate datele; nu se completează nimic din celălalt."
        }</div>
        ${v.aliasNou ? `<div style="font-size:13px;margin-top:4px">Numele „${esc(v.aliasNou)}” rămâne ținut minte ca alt nume al lui.</div>` : ""}
        ${v.adrese.length ? `<div style="font-size:13px;margin-top:4px">Intră printre adresele lui de livrare: ${v.adrese.map((a) => "<strong>" + esc(a.adresa) + "</strong>").join("; ")}.</div>` : ""}
      </div>
      <form method="post" action="${CALE}/unifica" style="max-width:980px;margin-top:12px" onsubmit="return confirm('Unifici? „${esc(String(v.inghitit.nume || "").replace(/['"\\]/g, ""))}” dispare din liste și tot ce are trece pe celălalt.')">
        <input type="hidden" name="pastrat_id" value="${P}"><input type="hidden" name="inghitit_id" value="${O}">
        <button class="btn" type="submit"${v.nestiute.length ? " disabled" : ""}>Unifică: „${esc(v.inghitit.nume)}” intră în „${esc(v.pastrat.nume)}”</button>
        <a class="btn secondary" href="${CALE}">Renunță</a>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Unificare clienți — verificare", active: "/configurari", body }));
  });

  router.post(`${CALE}/unifica`, async (ctx) => {
    const P = idDin(ctx.body.pastrat_id), O = idDin(ctx.body.inghitit_id);
    let v, r;
    try {
      v = await PF.previzualizeaza(P, O);
      r = await PF.fuzioneaza(P, O, ctx.user ? ctx.user.id : null);
    } catch (e) {
      console.error("[unificare-clienti] unificarea a căzut:", e.message);
      return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Unificarea n-a mers și nu s-a schimbat nimic: " + String(e.message).slice(0, 400))}`);
    }
    console.log(`[unificare-clienti] #${O} „${v.inghitit.nume}” a intrat în #${P} „${v.pastrat.nume}”: ${r.total} rânduri, de ${ctx.user ? ctx.user.nume : "?"}`);
    redirect(ctx.res, `${CALE}?ok=${encodeURIComponent(`„${v.inghitit.nume}” a intrat în „${v.pastrat.nume}”: ${r.total} ${r.total === 1 ? "rând mutat" : "rânduri mutate"}. Se poate desface din „Unificări făcute”.`.slice(0, 600))}`);
  });

  // „Nu e același client": perechea nu se mai propune.
  router.post(`${CALE}/respinge`, async (ctx) => {
    const x = idDin(ctx.body.a_id), y = idDin(ctx.body.b_id);
    if (!x || !y || x === y) return redirect(ctx.res, CALE);
    await db
      .prepare("INSERT INTO parteneri_unificare_respinse (a_id, b_id, facut_de) VALUES (?, ?, ?) ON CONFLICT (a_id, b_id) DO NOTHING")
      .run(Math.min(x, y), Math.max(x, y), ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `${CALE}?ok=${encodeURIComponent("Am notat: nu e același client. Perechea nu mai apare.")}`);
  });

  router.post(`${CALE}/desfa`, async (ctx) => {
    try {
      const r = await PF.desfa(idDin(ctx.body.fuziune_id), ctx.user ? ctx.user.id : null);
      console.log(`[unificare-clienti] unificarea ${idDin(ctx.body.fuziune_id)} desfăcută de ${ctx.user ? ctx.user.nume : "?"}: #${r.revenit} a revenit`);
      redirect(ctx.res, `${CALE}?parte=facute&ok=${encodeURIComponent("Unificarea e desfăcută: partenerul a revenit, cu rândurile lui.")}`);
    } catch (e) {
      redirect(ctx.res, `${CALE}?parte=facute&eroare=${encodeURIComponent("Nu s-a desfăcut și nu s-a schimbat nimic: " + String(e.message).slice(0, 400))}`);
    }
  });
}

module.exports = { register, CALE };
