"use strict";
// Management utilizatori — doar pentru admin (accesul e restricționat la
// nivel de server.js, vezi lib/auth.js ACCES_ROL; 'admin' are voie oricum).
const db = require("../lib/db");
const auth = require("../lib/auth");
const { esc, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function optiuniRoluri(rolSelectat) {
  return Object.entries(auth.ROLURI)
    .map(([v, l]) => `<option value="${v}" ${v === rolSelectat ? "selected" : ""}>${esc(l)}</option>`)
    .join("");
}

function register(router) {
  // Bifele de acces. O secțiune = o intrare din meniul de sus; ce nu e bifat
  // nu apare în meniu și dă 403 dacă omul nimerește adresa direct.
  //
  // Cât timp nu e bifat nimic, rămâne în picioare împărțirea veche pe roluri —
  // altfel, la prima salvare fără bife, omul ar rămâne fără nimic.
  function bifeSectiuni(u) {
    const alese = new Set(auth.sectiuniLista(u && u.sectiuni));
    const nimicBifat = alese.size === 0;
    const linii = auth.ZONE.map(
      (z) => `<label class="bifa">
          <input type="checkbox" name="sectiuni" value="${esc(z.cheie)}"${alese.has(z.cheie) ? " checked" : ""}>
          <span>${esc(z.eticheta)}${z.sensibil ? ' <span class="badge galben">sensibil</span>' : ""}</span>
        </label>`
    ).join("");
    return `<div class="field">
        <span>Ce secțiuni vede</span>
        <div class="bife">${linii}</div>
        <p class="ajutor">
          Sunt exact intrările din meniul de sus. Administratorul vede tot, oricum — nu i se poate lua nimic.
          ${nimicBifat ? "Momentan nu e bifat nimic, deci omul vede ce-i dădea rolul lui dinainte." : ""}
        </p>
      </div>`;
  }

  function sectiuniDinFormular(body) {
    const cerute = [].concat(body.sectiuni || []).map((x) => String(x).trim());
    const valide = new Set(auth.ZONE.map((z) => z.cheie));
    const alese = [...new Set(cerute.filter((x) => valide.has(x)))];
    return alese.length ? alese.join(",") : null;
  }

  router.get("/admin/utilizatori", async (ctx) => {
    const utilizatori = await db.prepare("SELECT * FROM utilizatori ORDER BY id ASC").all();
    const body = `
      <div class="toolbar"><a href="/admin/utilizatori/nou" class="btn">+ Utilizator nou</a></div>
      ${table(
        ["Nume", "Email", "Rol", "Vede", "Comision", "Stare", "Acțiuni"],
        utilizatori.map((u) => [
          esc(u.nume),
          esc(u.email),
          esc(auth.ROLURI[u.rol] || u.rol),
          u.rol === "admin"
            ? '<span class="badge verde">tot</span>'
            : (() => {
                const alese = auth.sectiuniLista(u.sectiuni);
                if (!alese.length) return '<span style="color:var(--text-muted);font-size:12px">după rol</span>';
                const et = new Map(auth.ZONE.map((z) => [z.cheie, z.eticheta]));
                return alese.map((c) => `<span class="badge gri">${esc(et.get(c) || c)}</span>`).join(" ");
              })(),
          `${Number(u.comision_procent ?? 0).toFixed(2)}%`,
          u.activ ? '<span class="badge verde">activ</span>' : '<span class="badge gri">dezactivat</span>',
          actionLinks([
            { href: `/admin/utilizatori/${u.id}/editare`, label: "Editează" },
            u.id !== ctx.user.id
              ? {
                  href: `/admin/utilizatori/${u.id}/comuta`,
                  label: u.activ ? "Dezactivează" : "Activează",
                  method: "post",
                  confirm: u.activ ? "Dezactivezi accesul acestui utilizator?" : "Reactivezi accesul?",
                }
              : null,
          ].filter(Boolean)),
        ])
      )}
      <p style="font-size:13px;color:var(--text-muted);margin-top:14px">
        Rolul spune ce fel de treabă face omul; <strong>ce vede</strong> se bifează separat, pe secțiunile din meniul de sus,
        din fișa lui. Administratorul are acces la tot. Cine n-are nicio bifă vede ce-i dădea rolul lui dinainte,
        ca nimeni să nu rămână blocat pe dinafară.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Utilizatori", active: "/admin/utilizatori", body }));
  });

  router.get("/admin/utilizatori/nou", async (ctx) => {
    const body = `<form method="post" action="/admin/utilizatori" class="form" style="max-width:480px">
      <label class="field"><span>Nume</span><input type="text" name="nume" required></label>
      <label class="field"><span>Email (folosit la login)</span><input type="email" name="email" required></label>
      <label class="field"><span>Parolă inițială</span><input type="text" name="parola" value="cashmachine" required minlength="6"></label>
      <label class="field"><span>Rol</span><select name="rol">${optiuniRoluri("vanzari")}</select></label>
      ${bifeSectiuni(null)}
      <label class="field"><span>Comision din încasări (%)</span><input type="number" step="0.01" name="comision_procent" value="2"></label>
      <label class="field"><span>Cost mașină pe lună (lei)</span><input type="number" step="0.01" name="cost_masina_lunar" value="0"></label>
      <label class="field"><span>Mașina (detalii)</span><input name="masina_detalii" value="" placeholder="ex. leasing Dacia Jogger"></label>
      <label class="field"><span>Card carburant OMV (nr. card / rezervă)</span><input name="card_carburant" value="" placeholder="ex. 003"></label>
      <label class="field"><span>Cod în registrul de comenzi</span><input name="cod_agent" value="" maxlength="6" placeholder="ex. IR"></label>
      <p class="ajutor">Codul cu care apare omul în registrul de comenzi (IR, VO, GT…). Dacă e gol, se ghicește din inițiale — dar inițialele se ciocnesc, deci acolo unde sunt doi cu aceleași, scrie-l aici.</p>

      <div class="form-actions">
        <button type="submit" class="btn">Creează utilizator</button>
        <a href="/admin/utilizatori" class="btn secondary">Renunță</a>
      </div>
    </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Utilizator nou", active: "/admin/utilizatori", body }));
  });

  router.post("/admin/utilizatori", async (ctx) => {
    const { nume, email, parola, rol } = ctx.body;
    try {
      // Parola implicită pentru orice cont nou; la prima logare e obligat s-o schimbe.
      const { hash, salt } = auth.hashParola(parola || "cashmachine");
      await db
        .prepare("INSERT INTO utilizatori (nume, email, parola_hash, parola_salt, rol, sectiuni, comision_procent, cost_masina_lunar, masina_detalii, card_carburant, cod_agent, parola_temporara) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
        .run(
          nume,
          (email || "").toLowerCase().trim(),
          hash,
          salt,
          rol || "vanzari",
          sectiuniDinFormular(ctx.body),
          Number(String(ctx.body.comision_procent ?? 2).replace(",", ".")) || 0,
          Number(String(ctx.body.cost_masina_lunar ?? 0).replace(",", ".")) || 0,
          String(ctx.body.masina_detalii || "").trim() || null,
          String(ctx.body.card_carburant || "").trim() || null,
          String(ctx.body.cod_agent || "").trim().toUpperCase() || null
        );
      redirect(ctx.res, "/admin/utilizatori");
    } catch (e) {
      const mesaj = e.code === "23505" ? "Există deja un utilizator cu acest email." : e.message;
      send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Eroare",
          active: "/admin/utilizatori",
          body: `<p style="color:var(--danger)">${esc(mesaj)}</p><a href="/admin/utilizatori/nou" class="btn secondary">Înapoi</a>`,
        })
      );
    }
  });

  router.get("/admin/utilizatori/:id/editare", async (ctx) => {
    const u = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(ctx.params.id);
    if (!u) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/admin/utilizatori", body: "<p>Utilizator inexistent.</p>" }));
    const body = `<form method="post" action="/admin/utilizatori/${u.id}/editare" class="form" style="max-width:480px">
      <label class="field"><span>Nume</span><input type="text" name="nume" value="${esc(u.nume)}" required></label>
      <label class="field"><span>Email</span><input type="email" name="email" value="${esc(u.email)}" required></label>
      <label class="field"><span>Rol</span><select name="rol">${optiuniRoluri(u.rol)}</select></label>
      <label class="field"><span>Comision din încasări (%)</span><input type="number" step="0.01" name="comision_procent" value="${Number(u.comision_procent ?? 2)}"></label>
      <label class="field"><span>Cost mașină pe lună (lei)</span><input type="number" step="0.01" name="cost_masina_lunar" value="${Number(u.cost_masina_lunar ?? 0)}"></label>
      <label class="field"><span>Mașina (detalii)</span><input name="masina_detalii" value="${esc(u.masina_detalii || "")}" placeholder="ex. leasing Dacia Jogger"></label>
      <label class="field"><span>Card carburant OMV (nr. card / rezervă)</span><input name="card_carburant" value="${esc(u.card_carburant || "")}" placeholder="ex. 003"></label>
      <label class="field"><span>Cod în registrul de comenzi</span><input name="cod_agent" value="${esc(u.cod_agent || "")}" maxlength="6" placeholder="ex. IR"></label>
      <p class="ajutor">Codul cu care apare omul în registrul de comenzi (IR, VO, GT…). Dacă e gol, se ghicește din inițiale — dar inițialele se ciocnesc, deci acolo unde sunt doi cu aceleași, scrie-l aici.</p>

      ${bifeSectiuni(u)}

      <label class="field"><span>Parolă nouă (opțional — lasă gol ca să nu o schimbi)</span><input type="password" name="parola" minlength="6"></label>
      <div class="form-actions">
        <button type="submit" class="btn">Salvează</button>
        <a href="/admin/utilizatori" class="btn secondary">Renunță</a>
      </div>
    </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Editare ${u.nume}`, active: "/admin/utilizatori", body }));
  });

  router.post("/admin/utilizatori/:id/editare", async (ctx) => {
    const { nume, email, rol, parola } = ctx.body;
    const comision = Number(String(ctx.body.comision_procent ?? 2).replace(",", ".")) || 0;
    if (parola && parola.length >= 6) {
      const { hash, salt } = auth.hashParola(parola);
      await db.prepare("UPDATE utilizatori SET nume = ?, email = ?, rol = ?, sectiuni = ?, comision_procent = ?, cost_masina_lunar = ?, masina_detalii = ?, card_carburant = ?, cod_agent = ?, parola_hash = ?, parola_salt = ?, parola_temporara = 1 WHERE id = ?").run(
        nume,
        (email || "").toLowerCase().trim(),
        rol,
        sectiuniDinFormular(ctx.body),
        comision,
        Number(String(ctx.body.cost_masina_lunar ?? 0).replace(",", ".")) || 0,
        String(ctx.body.masina_detalii || "").trim() || null,
        String(ctx.body.card_carburant || "").trim() || null,
        String(ctx.body.cod_agent || "").trim().toUpperCase() || null,
        hash,
        salt,
        ctx.params.id
      );
    } else {
      await db
        .prepare("UPDATE utilizatori SET nume = ?, email = ?, rol = ?, sectiuni = ?, comision_procent = ?, cost_masina_lunar = ?, masina_detalii = ?, card_carburant = ?, cod_agent = ? WHERE id = ?")
        .run(
          nume,
          (email || "").toLowerCase().trim(),
          rol,
          sectiuniDinFormular(ctx.body),
          comision,
          Number(String(ctx.body.cost_masina_lunar ?? 0).replace(",", ".")) || 0,
          String(ctx.body.masina_detalii || "").trim() || null,
          String(ctx.body.card_carburant || "").trim() || null,
          String(ctx.body.cod_agent || "").trim().toUpperCase() || null,
          ctx.params.id
        );
    }
    redirect(ctx.res, "/admin/utilizatori");
  });

  router.post("/admin/utilizatori/:id/comuta", async (ctx) => {
    if (String(ctx.params.id) === String(ctx.user.id)) return redirect(ctx.res, "/admin/utilizatori");
    await db.prepare("UPDATE utilizatori SET activ = CASE WHEN activ = 1 THEN 0 ELSE 1 END WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/admin/utilizatori");
  });
}

module.exports = { register };
