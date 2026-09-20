"use strict";
// Accesul la Google (Gmail și Drive), scris pe modulele native ale Node
// (`https`, `crypto`) — fără nicio dependință externă, ca restul aplicației.
//
// De ce service account și nu OAuth pentru fiecare om:
// un tool de firmă nu are voie să depindă de cine a dat clic pe ce. Cu
// delegare la nivel de domeniu, administratorul autorizează o singură dată,
// nimeni nu mai are de bifat nimic, iar când pleacă un om istoricul rămâne în
// ERP — pe OAuth per utilizator ar pleca odată cu el.
//
// Împărțirea drepturilor, intenționat asimetrică:
//   - Gmail: se impersonează fiecare căsuță, cu scope gmail.readonly. Doar
//     citire, deci ERP-ul nu poate șterge un email și nu-l poate marca citit.
//   - Drive: NU se impersonează nimeni. Service account-ul lucrează sub
//     identitatea lui proprie și ajunge doar unde i s-a dat share explicit.
//     Cu delegare pe Drive ar fi putut umbla în tot Drive-ul fiecărui om.
const https = require("https");
const crypto = require("crypto");

const URL_TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";

// --- cheia de service account ---------------------------------------------
let cache = undefined;

function cont() {
  if (cache !== undefined) return cache;
  const brut = String(process.env.GOOGLE_SA_JSON || "").trim();
  if (!brut) {
    cache = { ok: false, eroare: "GOOGLE_SA_JSON nu e setată în Render (pasul 4 din ghid)." };
    return cache;
  }
  let j;
  try {
    j = JSON.parse(brut);
  } catch (e) {
    cache = { ok: false, eroare: "GOOGLE_SA_JSON nu e un JSON valid. Ai lipit tot fișierul, de la prima acoladă până la ultima?" };
    return cache;
  }
  if (!j.client_email || !j.private_key) {
    cache = { ok: false, eroare: "JSON-ul nu are client_email și private_key — nu e cheia unui service account. Refă pasul 1.6 din ghid." };
    return cache;
  }
  // Când cheia se lipește într-o variabilă de mediu, rândurile noi ajung
  // uneori ca două caractere, „\" și „n". OpenSSL nu citește așa ceva, iar
  // omul care a lipit-o n-are de unde ști. Se repară aici, nu pe fișa lui.
  const cheie = String(j.private_key).includes("\\n") ? String(j.private_key).replace(/\\n/g, "\n") : String(j.private_key);
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(cheie.trim())) {
    cache = { ok: false, eroare: "private_key din JSON nu arată a cheie PEM. Probabil s-a copiat trunchiat." };
    return cache;
  }
  cache = { ok: true, email: j.client_email, cheie, proiect: j.project_id || "", clientId: j.client_id || "" };
  return cache;
}

// Pentru teste și pentru cazul în care se schimbă variabilele fără restart.
function reseteaza() {
  cache = undefined;
  jetoane.clear();
}

function folderDrive() {
  return String(process.env.GOOGLE_DRIVE_FOLDER || "").trim();
}

// --- JWT semnat RS256 ------------------------------------------------------
function base64url(x) {
  return Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function semneaza(antet, incarcatura, cheiePrivata) {
  const a = base64url(JSON.stringify(antet));
  const b = base64url(JSON.stringify(incarcatura));
  const s = crypto.createSign("RSA-SHA256").update(`${a}.${b}`).sign(cheiePrivata);
  return `${a}.${b}.${base64url(s)}`;
}

// --- cererea HTTPS de bază -------------------------------------------------
function cerereBruta(metoda, adresa, opt) {
  const o = opt || {};
  return new Promise((rezolva, respinge) => {
    let u;
    try {
      u = new URL(adresa);
    } catch (e) {
      return respinge(new Error("adresă invalidă: " + adresa));
    }
    const antete = Object.assign({ Accept: "application/json" }, o.antete || {});
    if (o.token) antete.Authorization = "Bearer " + o.token;
    let corp = o.corp;
    if (o.json !== undefined) {
      corp = JSON.stringify(o.json);
      antete["Content-Type"] = "application/json; charset=utf-8";
    }
    if (corp !== undefined && corp !== null) antete["Content-Length"] = Buffer.byteLength(corp);

    const req = https.request(
      { method: metoda, hostname: u.hostname, path: u.pathname + u.search, headers: antete },
      (res) => {
        const bucati = [];
        res.on("data", (d) => bucati.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(bucati);
          let json = null;
          if (!o.binar) {
            try {
              json = JSON.parse(buf.toString("utf8"));
            } catch (e) {
              /* nu tot ce vine de la Google e JSON */
            }
          }
          rezolva({ cod: res.statusCode, antete: res.headers, corp: buf, json, text: o.binar ? "" : buf.toString("utf8") });
        });
      }
    );
    req.setTimeout(o.timeout || 30000, () => req.destroy(new Error(`Google n-a răspuns în ${Math.round((o.timeout || 30000) / 1000)} secunde`)));
    req.on("error", respinge);
    if (corp !== undefined && corp !== null) req.write(corp);
    req.end();
  });
}

const asteapta = (ms) => new Promise((r) => setTimeout(r, ms));

// Google dă 429 și 5xx la supărare, nu la greșeală. Se reîncearcă de trei ori,
// cu pauze crescătoare. Restul codurilor sunt răspunsuri, nu accidente, și se
// întorc ca atare — cine a chemat decide ce face cu ele.
async function cerere(metoda, adresa, opt) {
  let ultima;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await cerereBruta(metoda, adresa, opt);
      if (r.cod === 429 || (r.cod >= 500 && r.cod < 600)) {
        ultima = r;
        if (i < 2) await asteapta(500 * Math.pow(3, i));
        continue;
      }
      return r;
    } catch (e) {
      ultima = e;
      if (i < 2) await asteapta(500 * Math.pow(3, i));
    }
  }
  if (ultima instanceof Error) throw ultima;
  return ultima;
}

// --- traducerea erorilor de la Google --------------------------------------
// Google răspunde cu „unauthorized_client" și atât. Omul care a făcut
// configurarea acum douăzeci de minute n-are cum să ghicească ce înseamnă, așa
// că fiecare eroare cunoscută spune la ce pas din ghid se repară.
function explica(r, casuta) {
  const j = (r && r.json) || {};
  const e = String(j.error || "");
  const d = String(j.error_description || "");
  if (e === "unauthorized_client")
    return `Google refuză delegarea${casuta ? ` pentru ${casuta}` : ""}. Fie Client ID-ul din Workspace Admin nu e cel al service account-ului, fie scope-ul gmail.readonly nu e trecut acolo, fie s-a scris cu un spațiu în plus. Pasul 2 din ghid. (${e}${d ? ": " + d : ""})`;
  if (e === "invalid_grant" && /email|subject/i.test(d))
    return `Căsuța ${casuta || ""} nu există pe domeniu sau e suspendată. Verifică adresa în Workspace. (${d})`;
  if (e === "invalid_grant" && /JWT|clock|expired|too early/i.test(d))
    return `Ceasul serverului e nepotrivit față de Google, sau cheia a fost ștearsă din Google Cloud. Dacă ai șters-o, generează alta la pasul 1.6. (${d})`;
  if (e === "invalid_client")
    return `Service account-ul nu mai există sau cheia a fost revocată. Pasul 1 din ghid. (${d || e})`;
  if (e === "access_denied") return `Google a refuzat accesul${casuta ? ` la ${casuta}` : ""}. Verifică scope-urile de la pasul 2. (${d || e})`;
  if (r && r.cod === 403 && /insufficient|scope/i.test(r.text || "")) return `Lipsește un scope. Pasul 2 din ghid. (${(r.text || "").slice(0, 200)})`;
  if (e) return `${e}${d ? ": " + d : ""}`;
  if (r && r.cod) return `Google a răspuns cu codul ${r.cod}: ${String(r.text || "").slice(0, 300)}`;
  return "eroare necunoscută de la Google";
}

// --- jetoane ---------------------------------------------------------------
const jetoane = new Map();

async function token(scopes, casuta) {
  const c = cont();
  if (!c.ok) throw new Error(c.eroare);
  const lista = Array.isArray(scopes) ? scopes.join(" ") : String(scopes);
  const cheieCache = lista + "|" + (casuta || "");
  const acum = Math.floor(Date.now() / 1000);
  const salvat = jetoane.get(cheieCache);
  // se reînnoiește cu un minut înainte de expirare, ca să nu pice o cerere
  // fix pe granița dintre două jetoane
  if (salvat && salvat.expira > acum + 60) return salvat.token;

  const incarcatura = { iss: c.email, scope: lista, aud: URL_TOKEN, iat: acum, exp: acum + 3600 };
  if (casuta) incarcatura.sub = casuta;
  const jwt = semneaza({ alg: "RS256", typ: "JWT" }, incarcatura, c.cheie);
  const corp = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString();
  const r = await cerere("POST", URL_TOKEN, { corp, antete: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!r.json || !r.json.access_token) throw new Error(explica(r, casuta));
  jetoane.set(cheieCache, { token: r.json.access_token, expira: acum + Number(r.json.expires_in || 3600) });
  return r.json.access_token;
}

const tokenGmail = (casuta) => token(SCOPE_GMAIL, casuta);
const tokenDrive = () => token(SCOPE_DRIVE, null);

// Un apel la API care aruncă dacă n-a mers. Pentru locurile unde „a mers pe
// jumătate" n-are sens.
async function apel(metoda, adresa, opt) {
  const r = await cerere(metoda, adresa, opt);
  if (r.cod < 200 || r.cod >= 300) throw new Error(explica(r, opt && opt.casuta));
  return r;
}

module.exports = {
  cont,
  reseteaza,
  folderDrive,
  semneaza,
  base64url,
  cerere,
  apel,
  token,
  tokenGmail,
  tokenDrive,
  explica,
  SCOPE_GMAIL,
  SCOPE_DRIVE,
  URL_TOKEN,
};
