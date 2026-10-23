"use strict";
// Fluxuri tehnologice: prin ce utilaje trece un produs, în ce ordine.
//
// Până acum drumul ăsta era ținut minte de oameni. O pungă curier imprimată
// trece prin extruder, poate prin slitter dacă lățimea extrudată nu e cea
// bună, prin flexo dacă e imprimată, apoi prin mașina de pungi — iar care
// mașină de pungi depinde de înălțime. Cine n-a mai făcut-o n-are de unde să
// știe, iar când lipsește un pas se descoperă la livrare.
//
// Trei lucruri pe care pagina le ține separate, fiindcă în practică sunt
// separate:
//
//   • PASUL OBLIGATORIU ȘI CEL OPȚIONAL nu se citesc la fel. Un pas opțional
//     fără condiție scrisă e o capcană: cineva îl va sări, și altcineva îl va
//     face degeaba. De-aia condiția stă pe rând, în clar.
//
//   • UN PAS POATE AVEA DOUĂ UTILAJE („UT10|UT11"). Nu se alege aici —
//     alegerea o fac regulile de alocare, după înălțimea produsului. Fluxul
//     spune CE se întâmplă, regula spune PE CE.
//
//   • REGULILE SE CITESC, NU SE DEDUC. R03 spune că o pungă mai înaltă de
//     800 mm cu tot cu clapă nu se poate produce. Scrisă într-un if din cod,
//     răspunsul la „de ce nu merge punga asta" ar fi fost „nu știu".
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);
function poate(user) {
  return Boolean(user && ["admin", "productie", "depozit"].includes(user.rol));
}
function text(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, max || 200) : null;
}

const TIP_PAS = {
  OBLIGATORIU: '<span class="badge albastru">obligatoriu</span>',
  OPTIONAL: '<span class="badge galben">opțional</span>',
};

function register(router) {
  // ---- Fluxurile ---------------------------------------------------------
  router.get("/fluxuri", async (ctx) => {
    const fluxuri = await db.prepare("SELECT * FROM fluxuri WHERE activ = 1 ORDER BY cod").all();
    const pasi = await db
      .prepare(
        `SELECT p.*, u.denumire AS utilaj_denumire, u.status_date
           FROM fluxuri_pasi p LEFT JOIN utilaje u ON u.id = p.utilaj_id
          ORDER BY p.flux_id, p.pas_nr`
      )
      .all();

    const peFlux = new Map();
    for (const p of pasi) {
      const k = Number(p.flux_id);
      if (!peFlux.has(k)) peFlux.set(k, []);
      peFlux.get(k).push(p);
    }

    const sectiuni = fluxuri
      .map((f) => {
        const lista = peFlux.get(Number(f.id)) || [];
        const randuri = lista.map((p) => [
          String(p.pas_nr),
          esc(p.utilaj_cod || "—") +
            (p.utilaj_denumire ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(p.utilaj_denumire)}</span>` : "") +
            (p.utilaj_cod && String(p.utilaj_cod).includes("|")
              ? '<br><span class="badge gri" style="font-size:10px">alege regula de alocare</span>'
              : "") +
            (String(p.utilaj_cod || "").toUpperCase() === "UT14" || p.status_date === "STANDBY"
              ? '<br><span class="badge rosu" style="font-size:10px">utilaj în standby</span>'
              : ""),
          esc(p.operatie || ""),
          TIP_PAS[String(p.tip_pas || "").toUpperCase()] || esc(p.tip_pas || ""),
          p.conditie
            ? esc(p.conditie)
            : String(p.tip_pas || "").toUpperCase() === "OPTIONAL"
              ? '<span class="badge rosu">pas opțional fără condiție scrisă</span>'
              : "—",
          poate(ctx.user)
            ? `<form method="post" action="/fluxuri/pas/${p.id}/sterge" class="inline-form"><button class="link-btn danger" type="submit">Șterge</button></form>`
            : "",
        ]);
        return `
          <h3 style="margin-top:26px">${esc(f.denumire || f.cod)} <span style="font-weight:400;color:var(--text-muted);font-size:14px">${esc(f.cod)}</span></h3>
          ${table(["Pas", "Utilaj", "Operație", "Fel", "Când se aplică", ""], randuri)}
          ${
            poate(ctx.user)
              ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Adaugă un pas</summary>
                   <form method="post" action="/fluxuri/${f.id}/pas" class="form" style="max-width:900px;margin-top:10px">
                     <div style="display:grid;grid-template-columns:70px 130px 2fr 160px 2fr;gap:10px">
                       <label class="field" style="margin:0"><span>Pas</span><input type="number" name="pas_nr" required value="${lista.length + 1}"></label>
                       <label class="field" style="margin:0"><span>Utilaj</span><input name="utilaj_cod" placeholder="UT10 sau UT10|UT11"></label>
                       <label class="field" style="margin:0"><span>Operație</span><input name="operatie" required></label>
                       <label class="field" style="margin:0"><span>Fel</span>
                         <select name="tip_pas"><option value="OBLIGATORIU">obligatoriu</option><option value="OPTIONAL">opțional</option></select></label>
                       <label class="field" style="margin:0"><span>Când se aplică</span><input name="conditie" placeholder="obligatoriu dacă pasul e opțional"></label>
                     </div>
                     <button class="btn small" type="submit">Adaugă pasul</button>
                   </form>
                 </details>`
              : ""
          }`;
      })
      .join("");

    const body = `
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block">${esc(ctx.query.eroare)}</p>` : ""}
      <p style="max-width:820px;color:var(--text-muted)">
        Prin ce utilaje trece fiecare familie de produse, în ce ordine. Pașii <strong>obligatorii</strong> se fac
        întotdeauna; cei <strong>opționali</strong> doar când se îndeplinește condiția scrisă pe rând. Un pas scris
        „UT10|UT11" merge pe oricare dintre cele două — alegerea o face regula de alocare, nu fluxul.
      </p>
      ${sectiuni || "<p>Niciun flux încă.</p>"}
      ${
        poate(ctx.user)
          ? `<h3 style="margin-top:32px">Flux nou</h3>
             <form method="post" action="/fluxuri" class="form" style="max-width:720px">
               <div style="display:grid;grid-template-columns:1fr 2fr 1fr;gap:14px">
                 <label class="field"><span>Cod</span><input name="cod" required placeholder="F-CEVA"></label>
                 <label class="field"><span>Denumire</span><input name="denumire" required></label>
                 <label class="field"><span>Familie</span><input name="familie"></label>
               </div>
               <button class="btn" type="submit">Adaugă fluxul</button>
             </form>`
          : ""
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Fluxuri tehnologice", active: "/fluxuri", body }));
  });

  router.post("/fluxuri", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/fluxuri");
    const b = ctx.body || {};
    const cod = text(b.cod, 40);
    if (!cod) return redirect(ctx.res, "/fluxuri");
    const e = await db.prepare("SELECT id FROM fluxuri WHERE cod = ?").get(cod);
    if (e) return redirect(ctx.res, "/fluxuri?eroare=" + encodeURIComponent("Există deja un flux cu codul " + cod + "."));
    await db
      .prepare("INSERT INTO fluxuri (cod, denumire, familie, activ) VALUES (?, ?, ?, 1)")
      .run(cod, text(b.denumire, 160), text(b.familie, 80));
    redirect(ctx.res, "/fluxuri");
  });

  router.post("/fluxuri/:id/pas", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/fluxuri");
    const fid = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const pas = parseInt(b.pas_nr, 10);
    if (!fid || !pas) return redirect(ctx.res, "/fluxuri");

    // Un pas optional fara conditie scrisa e o capcana: cineva il va sari, si
    // altcineva il va face degeaba. Nimeni n-are de unde sa stie care din doi
    // a gresit.
    const tip = String(b.tip_pas || "OBLIGATORIU").toUpperCase() === "OPTIONAL" ? "OPTIONAL" : "OBLIGATORIU";
    const conditie = text(b.conditie, 300);
    if (tip === "OPTIONAL" && !conditie) {
      return redirect(ctx.res, "/fluxuri?eroare=" + encodeURIComponent("Un pas opțional are nevoie de condiția în care se aplică. Altfel unul îl sare și altul îl face degeaba."));
    }
    const ocupat = await db.prepare("SELECT id FROM fluxuri_pasi WHERE flux_id = ? AND pas_nr = ?").get(fid, pas);
    if (ocupat) {
      return redirect(ctx.res, "/fluxuri?eroare=" + encodeURIComponent("Pasul " + pas + " există deja pe fluxul ăsta."));
    }
    const codUtilaj = text(b.utilaj_cod, 40);
    const unul =
      codUtilaj && !codUtilaj.includes("|")
        ? await db.prepare("SELECT id FROM utilaje WHERE upper(cod) = upper(?)").get(codUtilaj)
        : null;
    await db
      .prepare("INSERT INTO fluxuri_pasi (flux_id, pas_nr, utilaj_cod, utilaj_id, operatie, tip_pas, conditie) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(fid, pas, codUtilaj, unul ? unul.id : null, text(b.operatie, 300), tip, conditie);
    redirect(ctx.res, "/fluxuri");
  });

  router.post("/fluxuri/pas/:id/sterge", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/fluxuri");
    await db.prepare("DELETE FROM fluxuri_pasi WHERE id = ?").run(parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/fluxuri");
  });

  // ---- Regulile de alocare ------------------------------------------------
  router.get("/fluxuri/reguli", async (ctx) => {
    const reguli = await db.prepare("SELECT * FROM utilaje_reguli ORDER BY regula_cod").all();
    const culoare = { ALOCARE: "albastru", RESTRICTIE: "rosu", CALCUL: "gri", CAPACITATE: "verde" };
    const randuri = reguli.map((r) => [
      esc(r.regula_cod),
      `<span class="badge ${culoare[String(r.tip || "").toUpperCase()] || "gri"}">${esc(String(r.tip || "").toLowerCase())}</span>`,
      esc(r.domeniu || "—"),
      esc(r.conditie || "—"),
      esc(r.actiune || "—"),
      esc(r.utilaje || "—"),
      esc(r.sursa || "—"),
    ]);
    const body = `
      <p style="max-width:820px;color:var(--text-muted)">
        Care utilaj poate face ce, și ce nu se poate face deloc. Stau scrise în clar, ca să poată răspunde cineva la
        întrebarea „de ce nu merge punga asta" — îngropate într-un <code>if</code> din cod, răspunsul ar fi fost
        „nu știu". <strong>Restricțiile</strong> (roșu) spun ce e imposibil, <strong>alocările</strong> spun pe ce
        utilaj merge, <strong>calculele</strong> spun cum iese dimensiunea foliei din dimensiunea produsului.
      </p>
      ${table(["Cod", "Tip", "Domeniu", "Condiție", "Ce se întâmplă", "Utilaje", "Sursa"], randuri)}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Reguli de alocare", active: "/fluxuri/reguli", body }));
  });

  // ---- Cilindrii flexo -----------------------------------------------------
  router.get("/fluxuri/cilindri", async (ctx) => {
    const c = await db.prepare("SELECT * FROM cilindri_flexo ORDER BY circumferinta_mm").all();
    const randuri = c.map((x) => [
      Math.round(nr(x.circumferinta_mm)) + " mm",
      String(x.bucati || 0),
      x.max_culori == null ? "—" : String(x.max_culori),
      esc(x.observatii || "—"),
    ]);
    const total = c.reduce((s, x) => s + nr(x.bucati), 0);
    const body = `
      <p style="max-width:820px;color:var(--text-muted)">
        Cilindrii de print pe care îi avem — ${total} bucăți. Contează la ce se poate imprima: lungimea pungii trebuie
        să încapă de un număr întreg de ori în circumferința cilindrului. Un format care nu încape nu se imprimă,
        oricât de liber ar fi utilajul.
      </p>
      ${table(["Circumferință", "Bucăți", "Max. culori", "Observații"], randuri)}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cilindri flexo", active: "/fluxuri/cilindri", body }));
  });
}

module.exports = { register };
