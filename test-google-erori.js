"use strict";
// Test pentru traducerea erorilor de la Google.
//
// De ce există: pagina de verificare a conexiunii Google a arătat, pe un
// Drive care refuza scrierea, textul „[object Object]". Cauza: Google are
// DOUĂ formate de eroare, iar noi îl citeam doar pe primul.
//
//   capătul de token (accounts.google.com/o/oauth2/token):
//     { "error": "unauthorized_client", "error_description": "..." }
//   API-urile REST (gmail.googleapis.com, www.googleapis.com/drive):
//     { "error": { "code": 403, "message": "...", "status": "PERMISSION_DENIED",
//                  "errors": [ { "reason": "storageQuotaExceeded" } ] } }
//
// Pe al doilea, String(j.error) dădea „[object Object]" și omul rămânea fără
// nicio informație — exact în momentul în care avea cea mai mare nevoie de ea.
//
// Nu atinge rețeaua și nu are nevoie de bază de date: explica() e o funcție
// pură peste răspunsul deja primit.
const path = require("path");
const Module = require("module");

const RAD = __dirname;
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const g = require(path.join(RAD, "lib", "google.js"));

let rele = 0;
function cere(ce, text, treb, interzis) {
  const lipsa = (treb || []).filter((t) => !text.includes(t));
  const gasite = (interzis || []).filter((t) => text.includes(t));
  if (lipsa.length || gasite.length) {
    rele++;
    console.log("  PROBLEMĂ " + ce +
      (lipsa.length ? ": lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : ": ") + "apare „" + gasite.join("”, „") + "”" : ""));
    console.log("           am primit: " + text.slice(0, 200));
  } else console.log("  ok       " + ce);
}

// Răspunsurile sunt copiate după forma reală a celor de la Google.
const raspuns = (cod, json) => ({ cod, json, text: JSON.stringify(json), antete: {}, corp: Buffer.from("") });
const rest = (cod, status, message, reason) =>
  raspuns(cod, { error: { code: cod, message, status, errors: reason ? [{ reason, message }] : undefined } });

console.log("Traducerea erorilor de la Google\n");

// --- 1. niciun mesaj nu mai are voie să fie „[object Object]" --------------
const toate = [
  rest(403, "PERMISSION_DENIED", "Service Accounts do not have storage quota.", "storageQuotaExceeded"),
  rest(403, "PERMISSION_DENIED", "The user does not have sufficient permissions for this file.", "insufficientFilePermissions"),
  rest(404, "NOT_FOUND", "File not found: 0AO97tmz6VO4gUk9PVA.", "notFound"),
  rest(403, "PERMISSION_DENIED", "The attempted action requires shared drive membership.", "forbidden"),
  rest(400, "INVALID_ARGUMENT", "Bad Request", "cannotAddParent"),
  rest(403, "PERMISSION_DENIED", "The app is not authorized to access this file.", "appNotAuthorizedToFile"),
  rest(500, "INTERNAL", "Internal Error", null),
  raspuns(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method" }),
  raspuns(400, { error: "invalid_grant", error_description: "Invalid email or User ID" }),
  raspuns(400, { error: "invalid_grant", error_description: "JWT signature is invalid" }),
  raspuns(401, { error: "invalid_client", error_description: "The OAuth client was not found." }),
  raspuns(403, { error: "access_denied", error_description: "" }),
  raspuns(503, {}),
];
let curat = true;
for (const r of toate) {
  const t = g.explica(r, "office@cashmachine.ro");
  if (/\[object Object\]/.test(t) || !t || t === "undefined") {
    curat = false;
    console.log("  PROBLEMĂ mesaj nefolositor pentru " + JSON.stringify(r.json).slice(0, 90) + " → " + t);
    rele++;
  }
}
if (curat) console.log("  ok       niciuna din cele " + toate.length + " erori nu mai dă „[object Object]”");

// --- 2. erorile de Drive spun ce e de făcut, nu doar ce s-a întâmplat ------
cere("My Drive în loc de Drive partajat",
  g.explica(rest(403, "PERMISSION_DENIED", "Service Accounts do not have storage quota.", "storageQuotaExceeded")),
  ["Drive partajat", "GOOGLE_DRIVE_FOLDER", "Pasul 3"], ["[object Object]"]);

cere("drept de scriere lipsă pe folder",
  g.explica(rest(403, "PERMISSION_DENIED", "The user does not have sufficient permissions for this file.", "insufficientFilePermissions")),
  ["Content manager", "Pasul 3"], ["[object Object]"]);

cere("ID de folder greșit",
  g.explica(rest(404, "NOT_FOUND", "File not found: 0AO97tmz6VO4gUk9PVA.", "notFound")),
  ["/folders/", "Pasul 3"], ["[object Object]"]);

cere("folderul cerut ca membru al Drive-ului partajat",
  g.explica(rest(403, "PERMISSION_DENIED", "The attempted action requires shared drive membership.", "forbidden")),
  ["Content manager"], ["[object Object]"]);

// --- 3. erorile vechi, de la capătul de token, au rămas la fel -------------
cere("delegarea nepusă în Workspace Admin",
  g.explica(raspuns(401, { error: "unauthorized_client", error_description: "Client is unauthorized" }), "office@cashmachine.ro"),
  ["delegarea", "office@cashmachine.ro", "Pasul 2"], []);

cere("căsuță inexistentă pe domeniu",
  g.explica(raspuns(400, { error: "invalid_grant", error_description: "Invalid email or User ID" }), "nimeni@cashmachine.ro"),
  ["nimeni@cashmachine.ro", "nu există pe domeniu"], []);

cere("cheie ștearsă din Google Cloud",
  g.explica(raspuns(400, { error: "invalid_grant", error_description: "JWT signature is invalid" })),
  ["1.6"], []);

cere("service account dispărut",
  g.explica(raspuns(401, { error: "invalid_client", error_description: "The OAuth client was not found." })),
  ["Pasul 1"], []);

// --- 4. un răspuns REST fără „reason" tot spune mesajul Google ------------
cere("eroare REST fără reason",
  g.explica(rest(500, "INTERNAL", "Internal Error", null)),
  ["Internal Error"], ["[object Object]"]);

// --- 5. un răspuns fără niciun JSON nu crapă ------------------------------
cere("răspuns fără JSON",
  g.explica({ cod: 502, json: null, text: "<html>Bad Gateway</html>" }),
  ["502"], ["[object Object]"]);
cere("răspuns lipsă cu totul", g.explica(null), ["eroare"], ["[object Object]"]);

// --- 6. helperul din inbox.js nu mai lasă obiecte brute să treacă ----------
// mesajul() nu e exportat, deci se verifică prin efectul lui: căutăm în sursă
// că nicăieri nu mai rămâne vechiul String(e.message || e).
const fs = require("fs");
const sursa = fs.readFileSync(path.join(RAD, "modules", "inbox.js"), "utf8");
if (sursa.includes("String(e.message || e)")) {
  rele++;
  console.log("  PROBLEMĂ a rămas un String(e.message || e) în inbox.js — acolo reapare „[object Object]”");
} else console.log("  ok       inbox.js trece toate erorile prin mesajul()");

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
