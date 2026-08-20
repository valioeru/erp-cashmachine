"use strict";

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
  { href: "/produse", label: "Produse" },
  { href: "/stocuri", label: "Stocuri" },
  { href: "/comenzi", label: "Vânzări (CRM)" },
  { href: "/facturi", label: "Facturare" },
  { href: "/angajati", label: "Angajați" },
  { href: "/salarii", label: "Salarizare" },
];

function layout({ title, active, body, flash }) {
  const navHtml = NAV.map(
    (item) =>
      `<a href="${item.href}" class="navlink${active === item.href ? " active" : ""}">${esc(item.label)}</a>`
  ).join("");

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
</header>
<main class="content">
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<h1>${esc(title)}</h1>
${body}
</main>
<footer class="footer">Aplicație internă — nu conține autentificare. A se folosi doar în rețea privată sau se adaugă login înainte de expunere publică.</footer>
</body>
</html>`;
}

function table(headers, rows) {
  const thead = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="table"><thead>${thead}</thead><tbody>${tbody || `<tr><td colspan="${headers.length}" class="empty">Niciun rând încă.</td></tr>`}</tbody></table>`;
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
