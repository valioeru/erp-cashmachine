"use strict";
// Totalul perioadei și tabelul pe luni care se deschide pe zile.
//
// Același rezumat sub listele mari (facturi, încasări, comenzi consumabile):
// un rând de total pentru perioada aleasă și, dedesubt, câte o linie pe lună
// cu săgeată; la apăsare se deschid zilele lunii, cu totalul lunii sub ele.
// Lista de sus arată documentele una câte una și e paginată; rezumatul de
// aici numără TOATĂ perioada, nu doar pagina de pe ecran.
//
// Intrarea e o listă de zile, fiecare cu „data" (aaaa-ll-zz) și câmpurile din
// `coloane`. Coloanele spun ce se adună și cum se afișează: „bani" prin
// money(), „nr" ca număr întreg.

const { esc, money } = require("./render");

const LUNI = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];

function etichetaLuna(l) {
  return `${LUNI[Number(String(l).slice(5, 7)) - 1] || l} ${String(l).slice(0, 4)}`;
}

function dataRo(d) {
  const s = String(d || "");
  return s.length >= 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
}

function aduna(zile, coloane) {
  const t = { zile: zile.length };
  for (const c of coloane) t[c.camp] = zile.reduce((s, z) => s + Number(z[c.camp] || 0), 0);
  return t;
}

function valoare(c, v) {
  return c.tip === "bani" ? money(v) : Number(v || 0).toLocaleString("ro-RO");
}

// Grila e aceeași pe antet, pe luni și pe zile, ca cifrele să stea una sub alta.
function grila(n) {
  return `display:grid;grid-template-columns:minmax(150px,1.4fr) repeat(${n},minmax(90px,1fr)) minmax(50px,.5fr);gap:8px;align-items:center`;
}

function rand(eticheta, t, coloane, stil) {
  return `<div style="${grila(coloane.length)}${stil || ""}"><span>${eticheta}</span>${coloane
    .map((c) => `<span style="text-align:right">${valoare(c, t[c.camp])}</span>`)
    .join("")}<span style="text-align:right">${t.zile}</span></div>`;
}

const STIL = `<style>
  .rezumat-zile details > summary { list-style: none; cursor: pointer; padding: 8px 6px; border-bottom: 1px solid var(--border, #e5e5e5); }
  .rezumat-zile details > summary::-webkit-details-marker { display: none; }
  .rezumat-zile .sageata { display: inline-block; width: 1em; font-size: 11px; transition: transform .15s; }
  .rezumat-zile details[open] .sageata { transform: rotate(90deg); }
  .rezumat-zile .zile { padding: 4px 0 12px 18px; font-size: 13px; }
  .rezumat-zile .zile > div { padding: 4px 6px; border-bottom: 1px dashed var(--border, #eee); }
</style>`;

// opt.titlu — titlul secțiunii; opt.eticheta — eticheta perioadei, în rândul de total.
function rezumatPeLuni(zile, coloane, opt) {
  const o = opt || {};
  if (!zile || !zile.length) return "";
  const peLuna = new Map();
  for (const z of zile) {
    const l = String(z.data).slice(0, 7);
    if (!peLuna.has(l)) peLuna.set(l, []);
    peLuna.get(l).push(z);
  }
  const luni = [...peLuna.keys()].sort().reverse();
  const total = aduna(zile, coloane);
  const antet = `<div style="${grila(coloane.length)};padding:6px;font-size:12px;color:var(--text-muted)"><span>Luna</span>${coloane
    .map((c) => `<span style="text-align:right">${esc(c.eticheta)}</span>`)
    .join("")}<span style="text-align:right">Zile</span></div>`;
  return `${STIL}
  <h2>${esc(o.titlu || "Pe luni")}</h2>
  <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">Apasă pe o lună ca să-i vezi zilele, cu totalul lunii dedesubt.</p>
  <div class="rezumat-zile" style="overflow-x:auto">
    ${antet}
    ${luni
      .map((l) => {
        const zl = peLuna.get(l).slice().sort((a, b) => String(b.data).localeCompare(String(a.data)));
        return `<details>
          <summary>${rand(`<span class="sageata">▸</span> <strong>${esc(etichetaLuna(l))}</strong>`, aduna(zl, coloane), coloane)}</summary>
          <div class="zile">
            ${zl.map((z) => rand(dataRo(z.data), { ...z, zile: "" }, coloane)).join("")}
            ${rand(`<strong>Total ${esc(etichetaLuna(l))}</strong>`, aduna(zl, coloane), coloane, ";font-weight:600")}
          </div>
        </details>`;
      })
      .join("")}
    ${rand(`<strong>Total${o.eticheta ? " " + esc(o.eticheta) : ""}</strong>`, total, coloane, ";padding:10px 6px;font-weight:600")}
  </div>`;
}

module.exports = { rezumatPeLuni, aduna, etichetaLuna };
