"use strict";
// Autentificare + roluri (multi-utilizator). Sesiuni simple, în memorie
// (cookie httpOnly cu un token aleator) — suficient pentru o aplicație
// internă cu o singură instanță web (planul Render "starter" nu scalează
// orizontal). La un restart/redeploy, toată lumea trebuie să se
// reautentifice — comportament acceptabil pentru un tool intern.
const crypto = require("crypto");
const db = require("./db");

const COOKIE_NAME = "erp_sesiune";
const SESIUNE_DURATA_MS = 30 * 24 * 60 * 60 * 1000; // 30 zile

const ROLURI = {
  admin: "Administrator",
  vanzari: "Agent vânzări",
  financiar: "Financiar / contabilitate",
  depozit: "Gestionar depozit",
};

// Pentru fiecare rol (în afară de admin, care are acces la tot): lista de
// prefixe de rută la care are voie. Un prefix "/x" dă acces și la "/x/y".
// Ajustabil ulterior — e o primă împărțire rezonabilă pe roluri.
const ACCES_ROL = {
  vanzari: ["/", "/parteneri", "/crm", "/taskuri", "/profil", "/comenzi", "/productie", "/produse", "/stocuri", "/rapoarte/pipeline", "/rapoarte/clienti"],
  financiar: ["/", "/parteneri", "/facturi", "/rapoarte", "/banca", "/taskuri", "/profil", "/angajati", "/salarii", "/costuri"],
  depozit: ["/", "/produse", "/stocuri", "/import", "/taskuri", "/profil", "/comenzi", "/productie", "/rapoarte/stocuri", "/rapoarte/comenzi"],
};

function poateAccesa(rol, pathname) {
  if (rol === "admin") return true;
  const prefixe = ACCES_ROL[rol];
  if (!prefixe) return false;
  return prefixe.some((p) => (p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p)));
}

// --- parole -----------------------------------------------------------
function hashParola(parola) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(parola, salt, 64).toString("hex");
  return { hash, salt };
}

function verificaParola(parola, hash, salt) {
  if (!hash || !salt) return false;
  const incercare = crypto.scryptSync(parola, salt, 64).toString("hex");
  const a = Buffer.from(incercare, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- sesiuni (în memorie) ----------------------------------------------
const sesiuni = new Map(); // token -> { userId, expiraLa }

function creeazaSesiune(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sesiuni.set(token, { userId, expiraLa: Date.now() + SESIUNE_DURATA_MS });
  return token;
}

function stergeSesiune(token) {
  sesiuni.delete(token);
}

async function utilizatorDinToken(token) {
  if (!token) return null;
  const sesiune = sesiuni.get(token);
  if (!sesiune) return null;
  if (sesiune.expiraLa < Date.now()) {
    sesiuni.delete(token);
    return null;
  }
  const user = await db.prepare("SELECT id, nume, email, rol, activ FROM utilizatori WHERE id = ?").get(sesiune.userId);
  if (!user || !user.activ) return null;
  return user;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieSesiune(token, opts) {
  const secure = opts && opts.secure ? "; Secure" : "";
  const maxAge = Math.floor(SESIUNE_DURATA_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function cookieStergere() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  ROLURI,
  ACCES_ROL,
  poateAccesa,
  hashParola,
  verificaParola,
  creeazaSesiune,
  stergeSesiune,
  utilizatorDinToken,
  parseCookies,
  cookieSesiune,
  cookieStergere,
};
