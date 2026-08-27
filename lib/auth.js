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
  // Agentul de vânzări vede DOAR CRM-ul (biroul lui, pipeline, lead-uri,
  // clienții lui) și profilul propriu. Tot ce ține de bani pe firmă,
  // facturare, stocuri sau costuri rămâne la admin/financiar.
  vanzari: ["/crm", "/parteneri", "/taskuri", "/profil"],
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

// --- sesiuni (în baza de date) ------------------------------------------
// Ținute în DB, nu în memorie: altfel fiecare redeploy deconectează pe toată
// lumea. Tokenul e aleatoriu pe 32 de octeți; expirarea se verifică la
// fiecare cerere, iar sesiunile expirate se curăță din mers.
async function creeazaSesiune(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expira = new Date(Date.now() + SESIUNE_DURATA_MS).toISOString().slice(0, 19).replace("T", " ");
  await db.prepare("INSERT INTO sesiuni (token, utilizator_id, expira_la) VALUES (?, ?, ?)").run(token, userId, expira);
  return token;
}

async function stergeSesiune(token) {
  if (!token) return;
  await db.prepare("DELETE FROM sesiuni WHERE token = ?").run(token);
}

async function utilizatorDinToken(token) {
  if (!token) return null;
  const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
  const s = await db.prepare("SELECT utilizator_id, expira_la FROM sesiuni WHERE token = ?").get(token);
  if (!s) return null;
  if (String(s.expira_la) < acum) {
    await db.prepare("DELETE FROM sesiuni WHERE token = ?").run(token);
    return null;
  }
  const user = await db
    .prepare("SELECT id, nume, email, rol, activ, COALESCE(comision_procent,2) AS comision_procent, COALESCE(parola_temporara,0) AS parola_temporara FROM utilizatori WHERE id = ?")
    .get(s.utilizator_id);
  if (!user || !user.activ) return null;
  return user;
}

// Curăță periodic sesiunile expirate (o dată pe oră e suficient).
async function curataSesiuni() {
  const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    await db.prepare("DELETE FROM sesiuni WHERE expira_la < ?").run(acum);
  } catch (e) {
    /* nu blocăm aplicația pentru curățenie */
  }
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
  curataSesiuni,
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
