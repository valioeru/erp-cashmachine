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

// Bara principală are șase intrări, nu șaisprezece. Fiecare e o zonă de
// lucru, iar ce ține de ea stă în subnavigația ei — altfel meniul se citește
// ca o listă de tabele din baza de date, nu ca munca oamenilor.
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/crm", label: "CRM" },
  { href: "/stocuri/ct-park", label: "Depozit", zona: "/depozit" },
  { href: "/productie", label: "Producție" },
  { href: "/financiar", label: "Financiar" },
  { href: "/rapoarte", label: "Rapoarte" },
  { href: "/admin/utilizatori", label: "Utilizatori", doarAdmin: true },
];

// Subnavigația CRM. Stă aici, într-un singur loc, pentru că e folosită din
// mai multe module — până acum era copiată în fiecare, ca să nu se ceară
// unele pe altele în cerc.
function subnavCrm(activ, user) {
  const eAdmin = user && user.rol === "admin";
  const linkuri = [
    ["/crm", "Pipeline"],
    ["/crm/birou", "Biroul meu"],
    ["/crm/alocare", "Clienții mei"],
    ["/crm/contacte", "Contactări"],
    ["/parteneri", "Parteneri"],
    ["/scadente", "Scadențe"],
    ["/oferte", "Oferte"],
    ["/contracte", "Contracte"],
    ["/comenzi", "Comenzi"],
    ["/produse", "Produse"],
    ["/calculator", "Calculator preț"],
    ["/crm/leaduri", "Lead-uri"],
    ["/crm/activitate", "Activitate & emailuri"],
    ["/taskuri", "Task-uri"],
  ];
  if (eAdmin) linkuri.push(["/alocari", "Alocări clienți"]);
  return subnav(linkuri, activ, user);
}

// Depozitul: ce e pe stoc, ce a comandat lumea și ce cumpărăm.
function subnavDepozit(activ, user) {
  return subnav(
    [
      ["/depozit", "Comenzi deschise"],
      ["/stocuri", "Stocuri & inventar"],
      ["/stocuri/ct-park", "Depozit CT-Park"],
      ["/depozit/aprovizionare", "De aprovizionat"],
      ["/depozite", "Locații"],
      ["/facturi/achizitii", "Achiziții"],
    ],
    activ,
    user
  );
}

// Banii și oamenii, la un loc: sunt aceleași mâini care se ocupă de ele.
function subnavFinanciar(activ, user) {
  return subnav(
    [
      ["/financiar", "Sumar"],
      ["/facturi", "Facturare"],
      ["/parteneri", "Parteneri"],
      ["/banca", "Bancă"],
      ["/angajati", "Angajați"],
      ["/salarii", "Salarizare"],
      ["/costuri", "Cost company"],
      ["/costuri/decont", "Decont agenți"],
      ["/import", "Import date"],
    ],
    activ,
    user
  );
}

// Din ce zonă a meniului face parte o pagină. Bara de sus are nouă intrări,
// dar aplicația are peste o sută de rute — asta le leagă, ca „Stocuri" să
// aprindă „Warehouse", iar „Salarii" să aprindă „Financiar".
const SECTIUNI = [
  [["/depozit", "/depozite", "/stocuri"], "/depozit"],
  [["/financiar", "/facturi", "/parteneri", "/banca", "/angajati", "/salarii", "/costuri", "/import"], "/financiar"],
  [["/crm", "/oferte", "/contracte", "/comenzi", "/produse", "/calculator", "/scadente", "/taskuri", "/alocari"], "/crm"],
  [["/productie"], "/productie"],
  [["/rapoarte"], "/rapoarte"],
  [["/admin"], "/admin/utilizatori"],
];

function sectiune(activ) {
  const p = String(activ || "/");
  if (p === "/") return "/";
  for (const [prefixe, zona] of SECTIUNI) {
    if (prefixe.some((x) => p === x || p.startsWith(x + "/"))) return zona;
  }
  return p;
}

// Subnavigația potrivită zonei, ca paginile vechi să n-o ceară fiecare.
function subnavPentru(activ, user) {
  const z = sectiune(activ);
  if (z === "/crm") return subnavCrm(activ, user);
  if (z === "/depozit") return subnavDepozit(activ, user);
  if (z === "/financiar") return subnavFinanciar(activ, user);
  if (z === "/productie") return subnavProductie(activ, user);
  if (z === "/admin/utilizatori") return subnavAdmin(activ, user);
  return "";
}

// Producția: comenzile ei, cererile venite din depozit și materia primă
// pe care o cere înapoi de la depozit.
function subnavProductie(activ, user) {
  return subnav(
    [
      ["/productie", "Comenzi în lucru"],
      ["/productie/cereri", "Cereri din depozit"],
      ["/productie/materie", "Materie primă"],
    ],
    activ,
    user
  );
}

// Administrare: ce ține de aplicație, nu de business.
function subnavAdmin(activ, user) {
  return subnav(
    [
      ["/admin/utilizatori", "Utilizatori"],
      ["/admin/sincronizare", "Agendă și știri"],
      ["/admin/backup", "Backup"],
      ["/alocari", "Alocări clienți"],
    ],
    activ,
    user
  );
}

// Un link către o pagină la care utilizatorul primește 403 nu e navigație, e
// o capcană. Așa că subnavigația arată doar ce poate deschide omul.
function subnav(linkuri, activ, user) {
  const permise = user ? linkuri.filter(([h]) => poateAccesa(user.rol, h)) : linkuri;
  if (!permise.length) return "";
  return `<div class="subnav">${permise
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

function layout({ title, active, body, flash, user }) {
  const navItems = NAV.filter((item) => {
    if (!user) return true; // ecranul de login n-are user — nu ar trebui să apară oricum
    if (item.doarAdmin) return user.rol === "admin";
    return poateAccesa(user.rol, item.zona || item.href);
  });
  const zonaActiva = sectiune(active);
  const navHtml = navItems
    .map((item) => `<a href="${item.href}" class="navlink${zonaActiva === (item.zona || item.href) ? " active" : ""}">${esc(item.label)}</a>`)
    .join("");

  // Dacă pagina nu și-a pus singură subnavigația, i-o punem noi.
  const corp = String(body || "").includes('class="subnav"') ? body : subnavPentru(active, user) + body;

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
${corp}
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

module.exports = { esc, money, layout, table, actionLinks, subnavCrm, subnavDepozit, subnavFinanciar, subnavProductie, subnavAdmin, subnavPentru, sectiune, NAV };
