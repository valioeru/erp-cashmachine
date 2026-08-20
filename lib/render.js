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
  { href: "/taskuri", label: "Task-uri" },
  { href: "/produse", label: "Produse" },
  { href: "/stocuri", label: "Stocuri" },
  { href: "/comenzi", label: "Comenzi" },
  { href: "/facturi", label: "Facturare" },
  { href: "/facturi/achizitii", label: "Achiziții" },
  { href: "/rapoarte", label: "Rapoarte" },
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
