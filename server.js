"use strict";
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Router } = require("./lib/router");
const db = require("./lib/db");
const auth = require("./lib/auth");

const router = new Router();

require("./modules/auth").register(router);
require("./modules/utilizatori").register(router);
require("./modules/dashboard").register(router);
require("./modules/alocari").register(router);
require("./modules/parteneri").register(router);
require("./modules/produse").register(router);
require("./modules/stocuri").register(router);
require("./modules/ct-park").register(router);
require("./modules/verificari").register(router);
require("./modules/comenzi").register(router);
require("./modules/facturi").register(router);
require("./modules/crm").register(router);
require("./modules/oferte").register(router);
require("./modules/contacte").register(router);
require("./modules/scadente").register(router);
require("./modules/sincronizare").register(router);
require("./modules/taskuri").register(router);
require("./modules/email").register(router);
require("./modules/rapoarte").register(router);
require("./modules/balanta").register(router);
require("./modules/cashflow").register(router);
require("./modules/costuri").register(router);
require("./modules/import").register(router);
require("./modules/punte").register(router);
// Utilajele se inregistreaza INAINTE de productie: rutele se potrivesc in
// ordinea inregistrarii, iar "/productie/:id" din productie.js ar inghiti
// "/productie/utilaje" daca ar veni primul.
require("./modules/utilaje").register(router);
require("./modules/productie").register(router);
require("./modules/banca").register(router);
require("./modules/angajati").register(router);
require("./modules/salarii").register(router);
require("./modules/warehouse").register(router);
require("./modules/financiar").register(router);
require("./modules/calculator").register(router);
require("./modules/backup").register(router);
require("./modules/decont").register(router);
require("./modules/configurari").register(router);
require("./modules/forecast").register(router);
require("./modules/comision").register(router);

router.get("/healthz", (ctx) => {
  ctx.res.writeHead(200, { "Content-Type": "text/plain" });
  ctx.res.end("ok");
});

// Rute accesibile fără autentificare (plus fișierele statice din /public,
// tratate separat mai jos).
// Rutele publice. /api/ingest e „puntea" prin care browserul trimite în ERP
// datele citite din SmartBill: nu se autentifică prin cookie de sesiune, ci
// printr-un token temporar generat de administrator (vezi modules/import.js).
// De-aia stă în afara gardului de sesiune — dar NU e deschisă: fără token
// valid și nexpirat, refuză orice.
const RUTE_PUBLICE = new Set(["/healthz", "/login", "/api/ingest", "/punte/facturi-linii.js", "/punte/sincronizare.js"]);

// Verificarea preliminară pe care o face browserul înainte de o cerere de pe
// alt origin (OPTIONS) vine fără cookie-uri — dacă o trimitem la /login,
// cererea adevărată nici nu mai pleacă. Preflight-ul trece, cererea de după el
// e cea care cere sesiune.
function ePreflight(req, cale) {
  return req.method === "OPTIONS" && (cale === "/api/ingest" || cale === "/api/facturi-fara-linii");
}

async function creeazaAdminInitialDacaLipseste() {
  const nr = (await db.prepare("SELECT COUNT(*) AS n FROM utilizatori").get()).n;
  if (nr > 0) return;
  const email = process.env.ADMIN_EMAIL || "valentin.oeru@cashmachine.ro";
  const parola = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("base64url");
  const { hash, salt } = auth.hashParola(parola);
  await db.prepare("INSERT INTO utilizatori (nume, email, parola_hash, parola_salt, rol) VALUES (?, ?, ?, ?, 'admin')").run("Administrator", email.toLowerCase(), hash, salt);
  console.log("=".repeat(70));
  console.log("Cont de administrator creat automat (nu mai există niciun utilizator):");
  console.log(`  Email:  ${email}`);
  console.log(`  Parolă: ${parola}`);
  console.log("Schimbă parola după prima logare, din pagina „Profilul meu”.");
  console.log("(Poți fixa dinainte email/parolă cu variabilele de mediu ADMIN_EMAIL / ADMIN_PASSWORD.)");
  console.log("=".repeat(70));
}

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(req.url));
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function paginaFaraAcces(user) {
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><title>Acces interzis · ERP</title>
  <link rel="stylesheet" href="/style.css"></head><body><main class="content" style="max-width:520px;margin:60px auto;text-align:center">
  <h1>Nu ai acces la această secțiune</h1>
  <p>Contul tău (rol: ${user.rol}) nu are voie să vadă această pagină. Dacă ar trebui să ai acces, cere unui administrator să-ți schimbe rolul din „Utilizatori”.</p>
  <a href="/" class="btn">Înapoi la Dashboard</a></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && serveStatic(req, res)) return;

  const { pathname } = new URL(req.url, "http://localhost");
  const curat = decodeURIComponent(pathname).replace(/\/+$/, "") || "/";

  // Preflight-ul CORS al punții de import nu trece prin gardul de sesiune:
  // browserul îl trimite fără cookie, iar un 302 spre /login l-ar rupe.
  if (req.method === "OPTIONS") {
    const preflight = await router.handle(req, res);
    if (preflight) return;
  }

  if (!RUTE_PUBLICE.has(curat) && curat !== "/logout" && !ePreflight(req, curat)) {
    const cookies = auth.parseCookies(req);
    const user = await auth.utilizatorDinToken(cookies[auth.COOKIE_NAME]);
    if (!user) {
      res.writeHead(302, { Location: `/login?redirect=${encodeURIComponent(curat)}` });
      return res.end();
    }
    // Parolă implicită încă neschimbată: utilizatorul e ținut pe pagina de
    // profil până își pune una proprie. Altfel conturile ar rămâne la
    // "cashmachine" la nesfârșit.
    const PERMISE_CU_PAROLA_TEMPORARA = new Set(["/profil", "/profil/parola", "/logout"]);
    if (user.parola_temporara && !PERMISE_CU_PAROLA_TEMPORARA.has(curat)) {
      res.writeHead(302, { Location: "/profil" });
      return res.end();
    }

    // Agentul de vânzări nu are dashboard general — pagina lui de start e CRM.
    // Redirectul trebuie să fie ÎNAINTE de verificarea de acces, altfel "/"
    // i-ar da 403 în loc să-l ducă unde trebuie.
    if (user.rol === "vanzari" && curat === "/" && !auth.poateAccesa(user, "/")) {
      res.writeHead(302, { Location: "/crm/birou" });
      return res.end();
    }
    if (!auth.poateAccesa(user, curat)) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(paginaFaraAcces(user));
    }
    // Ștergerile de date sunt rezervate administratorului. Agenții (și
    // celelalte roluri) pot adăuga și modifica, dar nu pot șterge clienți,
    // facturi, oportunități etc. — cerință explicită de business.
    if (user.rol !== "admin" && req.method === "POST" && /\/(sterge|curata-tot)(\/|$)/.test(curat)) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(paginaFaraAcces(user));
    }
    req.utilizator = user;
  } else if (curat === "/logout") {
    // /logout are nevoie de cookie ca să știe ce sesiune să șteargă, dar nu
    // blocăm cererea dacă din orice motiv cookie-ul lipsește deja.
    const cookies = auth.parseCookies(req);
    req.utilizator = await auth.utilizatorDinToken(cookies[auth.COOKIE_NAME]);
  }

  const handled = await router.handle(req, res);
  if (!handled) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>404</h1><p>Pagina nu a fost găsită. <a href=\"/\">Înapoi la dashboard</a>.</p>");
  }
});

async function start() {
  await db.migrate();
  await creeazaAdminInitialDacaLipseste();
  await require("./lib/grup").asiguraFirme();
  await require("./modules/sincronizare").incarcaTot();
  await require("./modules/calculator").seed();
  require("./modules/warehouse").porneste();
  await auth.curataSesiuni();
  setInterval(() => auth.curataSesiuni(), 60 * 60 * 1000).unref();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`ERP pornit: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Eroare la pornirea aplicației:", err);
  process.exit(1);
});
