"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Router } = require("./lib/router");
const db = require("./lib/db");
const { seedIfEmpty } = require("./lib/seed");

const router = new Router();

require("./modules/dashboard").register(router);
require("./modules/parteneri").register(router);
require("./modules/produse").register(router);
require("./modules/stocuri").register(router);
require("./modules/comenzi").register(router);
require("./modules/facturi").register(router);
require("./modules/angajati").register(router);
require("./modules/salarii").register(router);

router.get("/healthz", (ctx) => {
  ctx.res.writeHead(200, { "Content-Type": "text/plain" });
  ctx.res.end("ok");
});

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

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && serveStatic(req, res)) return;
  const handled = await router.handle(req, res);
  if (!handled) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>404</h1><p>Pagina nu a fost găsită. <a href=\"/\">Înapoi la dashboard</a>.</p>");
  }
});

async function start() {
  await db.migrate();
  await seedIfEmpty();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`ERP pornit: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Eroare la pornirea aplicației:", err);
  process.exit(1);
});
