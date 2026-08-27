"use strict";
const { ROLURI, poateAccesa } = require("./auth");

function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(v) {
  const n = Number(v || 0);
  return n.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";
}

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/parteneri", label: "Parteneri" },
  { href: "/crm", label: "CRM" },
  { href: "/scadente", label: "Scadențe" },
  { href: "/oferte", label: "Oferte" },
  { href: "/contracte", label: "Contracte" },
  { href: "/alocari", label: "Alocări clienți", doarAdmin: true },
  { href: "/taskuri", label: "Task-uri" },
  { href: "/produse", label: "Produse" },
  { href: "/stocuri", label: "Stocuri" },
  { href: "/comenzi", label: "Comenzi" },
  { href: "/productie", label: "Producție" },
  { href: "/facturi", label: "Facturare" },
  { href: "/facturi/achizitii", label: "Achiziții" },
  { href: "/rapoarte", label: "Rapoarte" },
  { href: "/banca", label: "Bancă" },
  { href: "/angajati", label: "Angajați" },
  { href: "/salarii", label: "Salarizare" },
  { href: "/import", label: "Import" },
  { href: "/admin/utilizatori", label: "Utilizatori", doarAdmin: true },
];

function layout({ title, active, body, flash, user }) {
  const navItems = NAV.filter((item) => {
    if (!user) return true; // ecranul de login n-are user — nu ar trebui să apară oricum
    if (item.doarAdmin) return user.rol === "admin";
    return poateAccesa(user.rol, item.href);
  });
  const navHtml = navItems
    .map((item) => `<a href="${item.href}" class="navlink${active === item.href ? " active" : ""}">${esc(item.label)}</a>`)
    .join("");

  const userBoxHtml = user
    ? `<div class="userbox">
        <a href="/profil" class="userbox-nume">${esc(user.nume)} <span class="userbox-rol">(${esc(ROLURI[user.rol] || user.rol)})</span></a>
        <form method="post" action="/logout" class="inline-form"><button type="submit" class="link-btn">Ieșire</button></form>
      </div>`
    : "";

  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ERP</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <div class="brand">ERP · Compania mea</div>
  <nav class="nav">${navHtml}</nav>
  ${userBoxHtml}
</header>
<main class="content">
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<h1>${esc(title)}</h1>
${body}
</main>
<footer class="footer">Acces pe bază de cont, cu roluri separate. Fiecare utilizator vede doar secțiunile permise rolului său.</footer>
<script>
// Sortare la click pe orice antet de tabel. Detectează automat numerele în
// format românesc ("1.234,56 lei"), datele (yyyy-mm-dd) și textul.
(function () {
  function valoare(td) {
    var t = (td.textContent || "").trim();
    if (!t || t === "—") return { n: null, t: "" };
    var d = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (d) return { n: Date.parse(d[0]), t: t.toLowerCase() };
    var curatat = t.replace(/lei|zile|%/g, "").trim();
    if (/^-?[\d.,\s]+$/.test(curatat) && /\d/.test(curatat)) {
      var nr = parseFloat(curatat.replace(/\./g, "").replace(/\s/g, "").replace(",", "."));
      if (!isNaN(nr)) return { n: nr, t: t.toLowerCase() };
    }
    return { n: null, t: t.toLowerCase() };
  }
  document.addEventListener("click", function (ev) {
    var th = ev.target.closest("th.sortabil");
    if (!th) return;
    var tabel = th.closest("table");
    var thead = th.closest("thead") || th.closest("tr").parentNode;
    // La tabele cu antet pe două rânduri (balanța) sortăm doar dacă antetul e
    // pe ultimul rând de antet — altfel indexul coloanei n-ar corespunde.
    var randuriAntet = tabel.querySelectorAll("thead tr").length || 1;
    if (randuriAntet > 1 && th.parentNode !== tabel.querySelector("thead tr:last-child")) return;
    var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
    var tbody = tabel.querySelector("tbody") || tabel;
    var randuri = Array.prototype.filter.call(tbody.querySelectorAll("tr"), function (r) {
      return r.querySelector("td") && !r.querySelector("td.empty");
    });
    if (randuri.length < 2) return;
    var directie = th.dataset.sort === "asc" ? -1 : 1;
    tabel.querySelectorAll("th.sortabil").forEach(function (x) { delete x.dataset.sort; x.classList.remove("sort-asc", "sort-desc"); });
    th.dataset.sort = directie === 1 ? "asc" : "desc";
    th.classList.add(directie === 1 ? "sort-asc" : "sort-desc");
    randuri.sort(function (a, b) {
      var va = valoare(a.children[idx] || {});
      var vb = valoare(b.children[idx] || {});
      if (va.n !== null && vb.n !== null) return (va.n - vb.n) * directie;
      if (va.n !== null) return -directie;
      if (vb.n !== null) return directie;
      return va.t.localeCompare(vb.t, "ro") * directie;
    });
    randuri.forEach(function (r) { tbody.appendChild(r); });
  });
})();
</script>
</body>
</html>`;
}

function table(headers, rows, opts) {
  // Toate antetele sunt sortabile la click (scriptul global din layout).
  // Un antet care începe cu "<" e HTML intenționat (ex: checkbox-ul de
  // „selectează tot" din Producție) — se redă ca atare și nu e sortabil.
  const thead = `<tr>${headers
    .map((h) => (String(h).startsWith("<") ? `<th>${h}</th>` : `<th class="sortabil" title="Click pentru sortare">${esc(h)}</th>`))
    .join("")}</tr>`;
  const tbody = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  // Rând de total opțional (opts.total = listă de celule, deja formatate).
  const tfoot =
    opts && Array.isArray(opts.total) && rows.length
      ? `<tfoot><tr style="font-weight:600;background:var(--bg-subtle,#f6f7f9);border-top:2px solid var(--border)">${opts.total
          .map((cell) => `<td>${cell}</td>`)
          .join("")}</tr></tfoot>`
      : "";
  return `<table class="table"><thead>${thead}</thead><tbody>${tbody || `<tr><td colspan="${headers.length}" class="empty">Niciun rând încă.</td></tr>`}</tbody>${tfoot}</table>`;
}

function actionLinks(links) {
  return `<div class="actions">${links
    .map((l) =>
      l.method === "post"
        ? `<form method="post" action="${l.href}" onsubmit="return confirm('${esc(l.confirm || "Sigur?")}')" class="inline-form"><button type="submit" class="link-btn ${l.danger ? "danger" : ""}">${esc(l.label)}</button></form>`
        : `<a href="${l.href}" class="link-btn">${esc(l.label)}</a>`
    )
    .join("")}</div>`;
}

module.exports = { esc, money, layout, table, actionLinks, NAV };
