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
  depozit: "Achiziții",
  productie: "Producție",
};

// Pentru fiecare rol (în afară de admin, care are acces la tot): lista de
// prefixe de rută la care are voie. Un prefix "/x" dă acces și la "/x/y".
// Ajustabil ulterior — e o primă împărțire rezonabilă pe roluri.
const ACCES_ROL = {
  // Agentul de vânzări vede DOAR CRM-ul (biroul lui, pipeline, lead-uri,
  // clienții lui) și profilul propriu. Tot ce ține de bani pe firmă,
  // facturare, stocuri sau costuri rămâne la admin/financiar.
  vanzari: ["/crm", "/scadente", "/oferte", "/contracte", "/comenzi", "/parteneri", "/taskuri", "/profil", "/produse", "/calculator", "/depozit/comanda", "/warehouse/comanda"],
  financiar: ["/", "/parteneri", "/scadente", "/oferte", "/contracte", "/facturi", "/rapoarte", "/banca", "/taskuri", "/profil", "/angajati", "/salarii", "/costuri", "/financiar", "/comenzi", "/calculator", "/produse"],
  depozit: ["/", "/produse", "/stocuri", "/depozite", "/depozit", "/warehouse", "/import", "/taskuri", "/profil", "/comenzi", "/productie", "/rapoarte/stocuri", "/rapoarte/comenzi", "/facturi/achizitii"],
  productie: ["/", "/productie", "/produse", "/stocuri", "/taskuri", "/profil", "/comenzi", "/rapoarte/stocuri", "/rapoarte/comenzi"],
};

// ---------------------------------------------------------------------------
// Accesul se dă pe secțiunile din meniul de sus, nu pe roluri fixe.
//
// Rolul rămâne (scrie pe fișa omului ce fel de treabă face), dar cine ce vede
// se bifează bucată cu bucată, din Utilizatori. Administratorul vede tot,
// mereu — nu i se poate lua nimic, ca să nu se încuie cineva pe dinafară.
//
// Aplicația are peste o sută de rute, dar meniul are opt intrări. „ZONE" sunt
// intrările, iar „SECTIUNI" leagă orice rută de intrarea ei — ca „Salarii" să
// cadă sub „Financiar" și „Stocuri" sub „Depozit".
const ZONE = [
  { cheie: "/", eticheta: "Dashboard", ghid: "dashboard" },
  { cheie: "/crm", eticheta: "CRM", ghid: "crm" },
  { cheie: "/depozit", eticheta: "Depozit", ghid: "depozit" },
  { cheie: "/productie", eticheta: "Producție", ghid: "productie" },
  { cheie: "/financiar", eticheta: "Financiar", ghid: "financiar" },
  { cheie: "/rapoarte", eticheta: "Rapoarte", ghid: "rapoarte" },
  { cheie: "/configurari", eticheta: "Configurări", sensibil: true, ghid: "configurari" },
  { cheie: "/admin/utilizatori", eticheta: "Utilizatori", sensibil: true, ghid: "utilizatori" },
];

// Capitolul de ghid al unei zone. Ce nu e o zonă de meniu (profilul, ghidul
// însuși) primește capitolul de început, cel cu intrarea în cont și bara de sus.
function ghidPentru(zona) {
  const z = ZONE.find((x) => x.cheie === zona);
  return (z && z.ghid) || "start";
}

const SECTIUNI = [
  [["/depozit", "/depozite", "/stocuri"], "/depozit"],
  [["/financiar", "/facturi", "/parteneri", "/banca", "/angajati", "/salarii", "/costuri", "/import"], "/financiar"],
  [["/crm", "/oferte", "/contracte", "/comenzi", "/produse", "/calculator", "/scadente", "/taskuri", "/alocari"], "/crm"],
  [["/productie"], "/productie"],
  [["/rapoarte"], "/rapoarte"],
  [["/configurari"], "/configurari"],
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

// Pagini la care are voie oricine e logat: profilul propriu și ieșirea.
// Fără ele, un om căruia nu i s-a bifat nicio secțiune n-ar putea nici măcar
// să-și schimbe parola.
const MEREU_PERMISE = ["/profil", "/logout", "/ghid"];

function sectiuniLista(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// „u" poate fi utilizatorul întreg (cazul normal) sau doar rolul, ca să nu se
// rupă apelurile vechi.
function poateAccesa(u, pathname) {
  const rol = typeof u === "string" ? u : u && u.rol;
  if (rol === "admin") return true;
  const p = String(pathname || "/");
  if (MEREU_PERMISE.some((x) => p === x || p.startsWith(x + "/"))) return true;

  const alese = typeof u === "string" ? [] : sectiuniLista(u && u.sectiuni);
  if (alese.length) return alese.includes(sectiune(p));

  // Cât timp adminul n-a bifat nimic pentru omul ăsta, rămâne împărțirea
  // veche pe roluri — ca nimeni să nu rămână pe dinafară după actualizare.
  const prefixe = ACCES_ROL[rol];
  if (!prefixe) return false;
  return prefixe.some((x) => (x === "/" ? p === "/" : p === x || p.startsWith(x + "/") || p.startsWith(x)));
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
    .prepare("SELECT id, nume, email, rol, activ, poza, sectiuni, COALESCE(comision_procent,2) AS comision_procent, COALESCE(parola_temporara,0) AS parola_temporara FROM utilizatori WHERE id = ?")
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
  ZONE,
  ghidPentru,
  sectiune,
  sectiuniLista,
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
