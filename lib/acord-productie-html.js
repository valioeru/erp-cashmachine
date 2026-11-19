"use strict";
// Ce se vede din acordul producției (lib/acord-productie.js): blocul „De
// revalidat" de pe pagina Producției, cel de pe pagina comenzii, istoricul
// cererilor și anunțul de pe formularul de modificare. Fără bază de date.
const { esc } = require("./render");
const ACP = require("./acord-productie");

const cand = (t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(t || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : String(t || "—");
};
const CULORI = { asteapta: "galben", aprobata: "verde", respinsa: "rosu", retrasa: "gri" };

function listaSchimbari(z) {
  const s = ACP.schimbarile(z);
  if (!s.length) return '<span style="color:var(--text-muted)">—</span>';
  return `<ul style="margin:4px 0 0;padding-left:18px">${s
    .map((x) => `<li><strong>${esc(x.ce)}</strong>: ${x.vechi ? esc(x.vechi) : "—"} → ${x.nou ? `<strong>${esc(x.nou)}</strong>` : "—"}</li>`)
    .join("")}</ul>`;
}

// Butoanele producției pe o cerere în așteptare.
function butoane(z, inapoi) {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
      <form method="post" action="/comenzi/modificari/${z.id}/aproba" style="margin:0"
            onsubmit="return confirm('Aprobi modificarea? Se aplică pe comandă acum.')">
        <input type="hidden" name="inapoi" value="${inapoi}">
        <button class="btn small" type="submit" data-aproba="${z.id}">Aprobă și aplică</button>
      </form>
      <form method="post" action="/comenzi/modificari/${z.id}/respinge" style="margin:0;display:flex;gap:6px;align-items:center">
        <input type="hidden" name="inapoi" value="${inapoi}">
        <input type="text" name="raspuns" placeholder="de ce respingi (obligatoriu)" maxlength="300" required style="min-width:220px">
        <button class="btn small secondary" type="submit" data-respinge="${z.id}">Respinge</button>
      </form>
    </div>`;
}

function mesaje(q) {
  const x = q || {};
  return (
    (x.ok_acord ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:820px;line-height:1.5">${esc(String(x.ok_acord))}</p>` : "") +
    (x.eroare_acord ? `<p style="color:var(--danger,#b42318);max-width:820px;font-weight:600" data-eroare-acord>${esc(String(x.eroare_acord))}</p>` : "")
  );
}

// Sus pe pagina Producției.
function deRevalidat({ user, cereri, query }) {
  const lista = cereri || [];
  if (!lista.length) return mesaje(query);
  const poate = ACP.eProductie(user);
  return `${mesaje(query)}
    <div class="detail-box" data-de-revalidat style="border-left:4px solid var(--warn,#c07018);max-width:980px;margin-bottom:14px">
      <strong>De revalidat: ${lista.length} ${lista.length === 1 ? "modificare cerută" : "modificări cerute"} pe comenzi preluate în producție.</strong>
      <div style="font-size:13px;color:var(--text-muted);margin:2px 0 6px">Comenzile rămân cum erau până le aprobi. La aprobare, modificarea se aplică pe loc.</div>
      ${lista
        .map(
          (z) => `<div style="border-top:1px solid var(--border,#e5e7eb);padding:8px 0" data-cerere="${z.id}">
            <a href="/comenzi/${z.comanda_id}"><strong>${esc(z.comanda_numar || "#" + z.comanda_id)}</strong></a> · ${esc(z.client || "")}
            <span style="color:var(--text-muted);font-size:13px"> — cerută de <strong>${esc(z.solicitat_de_nume || "?")}</strong>, ${esc(cand(z.solicitat_la))}</span>
            ${z.motiv ? `<div style="font-size:13px">Motiv: ${esc(z.motiv)}</div>` : ""}
            <div style="font-size:13px">${listaSchimbari(z)}</div>
            ${poate ? butoane(z, "productie") : ""}
          </div>`
        )
        .join("")}
    </div>`;
}

// Pe pagina comenzii: `sus` (ce așteaptă) și `istoric` (toate cererile).
function peComanda({ user, cereri, preluata, query }) {
  const toate = cereri || [];
  const z = toate.find((x) => x.stare === "asteapta");
  const poate = ACP.eProductie(user);
  let sus = mesaje(query);
  if (z) {
    const alLui = user && Number(z.solicitat_de_id) === Number(user.id);
    sus += `<div class="detail-box" data-asteapta-productia style="border-left:4px solid var(--warn,#c07018);max-width:980px;margin-bottom:12px">
        <strong>De revalidat de producție: o modificare cerută pe comanda asta încă nu e aplicată.</strong>
        <div style="font-size:13px;color:var(--text-muted)">Cerută de <strong>${esc(z.solicitat_de_nume || "?")}</strong>, ${esc(cand(z.solicitat_la))}. Comanda de mai jos e cea de dinainte.</div>
        ${z.motiv ? `<div style="font-size:13px">Motiv: ${esc(z.motiv)}</div>` : ""}
        <div style="font-size:13px">${listaSchimbari(z)}</div>
        ${poate ? butoane(z, "comanda") : ""}
        ${
          alLui || (user && user.rol === "admin")
            ? `<form method="post" action="/comenzi/modificari/${z.id}/retrage" style="margin:8px 0 0"><input type="hidden" name="inapoi" value="comanda"><button class="link-btn" type="submit">Retrage cererea</button></form>`
            : ""
        }
      </div>`;
  } else if ((preluata || []).length && !poate) {
    sus += `<p data-preluata-in-productie style="max-width:980px;font-size:13px;color:var(--text-muted);border-left:4px solid var(--border,#d1d5db);padding:6px 10px">
        Comanda e preluată în producție (${esc(preluata.map((p) => p.numar || "#" + p.id).join(", "))}): o modificare se aplică doar după acordul producției.</p>`;
  }
  const istoric = toate.length
    ? `<h2>Modificări cerute cu acordul producției</h2>
       <table class="table" data-istoric-acord><thead><tr><th>Cerută</th><th>De cine</th><th>Ce</th><th>Stare</th><th>Validată de</th><th>Când</th><th>Răspuns</th></tr></thead><tbody>
       ${toate
         .map(
           (x) => `<tr>
             <td style="white-space:nowrap">${esc(cand(x.solicitat_la))}</td>
             <td>${esc(x.solicitat_de_nume || "—")}</td>
             <td style="font-size:13px">${x.motiv ? `Motiv: ${esc(x.motiv)}` : ""}${listaSchimbari(x)}</td>
             <td><span class="badge ${CULORI[x.stare] || "gri"}">${esc(ACP.STARI[x.stare] || x.stare)}</span></td>
             <td>${x.stare === "asteapta" ? "—" : esc(x.validat_de_nume || "—")}</td>
             <td style="white-space:nowrap">${x.stare === "asteapta" ? "—" : esc(cand(x.validat_la))}</td>
             <td style="font-size:13px">${x.raspuns ? esc(x.raspuns) : "—"}</td>
           </tr>`
         )
         .join("")}
       </tbody></table>`
    : "";
  return { sus, istoric };
}

// Deasupra formularului de modificare.
function peFormular({ user, preluata, asteapta }) {
  if (!(preluata || []).length) return "";
  if (ACP.eProductie(user)) {
    return `<p data-acord-direct style="max-width:900px;border-left:4px solid var(--primary,#2f5d9c);padding:8px 12px;font-size:13px">
      Comanda e preluată în producție. Ai Producția, deci modificarea se aplică direct și se scrie în istoric ca făcută cu acordul tău.</p>`;
  }
  return `<p data-acord-necesar style="max-width:900px;border-left:4px solid var(--warn,#c07018);padding:8px 12px;font-size:13px">
      <strong>Comanda e preluată în producție.</strong> Ce salvezi aici <strong>nu se aplică pe loc</strong>: pleacă la producție, de revalidat, și se aplică doar dacă o aprobă.
      ${asteapta ? `<br><strong>E deja o modificare în așteptare</strong> (cerută de ${esc(asteapta.solicitat_de_nume || "?")}, ${esc(cand(asteapta.solicitat_la))}) — până nu se închide, nu se poate cere alta.` : ""}</p>`;
}

module.exports = { deRevalidat, peComanda, peFormular, cand };
