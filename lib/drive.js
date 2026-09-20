"use strict";
// Urcarea atașamentelor în Drive-ul partajat.
//
// Service account-ul lucrează sub identitatea lui proprie, NU impersonează pe
// nimeni. Nu are acces decât unde i s-a dat share explicit — folderul de
// atașamente. Asta e toată granița lui în Drive, și e o graniță de membru, nu
// de scope: chiar dacă cineva lărgește scope-urile din greșeală, tot n-ar
// ajunge în alte foldere.
//
// `supportsAllDrives` e pus peste tot fiindcă folderul poate fi într-un Drive
// partajat (Shared Drive), iar fără flag-ul ăsta API-ul se face că nu-l vede.
const crypto = require("crypto");
const g = require("./google");

const FISIERE = "https://www.googleapis.com/drive/v3/files";
const URCARE = "https://www.googleapis.com/upload/drive/v3/files";
const COMUN = "supportsAllDrives=true&includeItemsFromAllDrives=true";
const MIME_FOLDER = "application/vnd.google-apps.folder";

function apostrof(s) {
  // în interogările Drive, apostroful se dublează
  return String(s || "").replace(/'/g, "\\'");
}

// Pe lângă nume, se cer și `driveId` și `capabilities`. Motivul: Drive
// răspunde la o scriere refuzată cu 404 „File not found", nu cu 403 — ca să
// nu dea de înțeles că fișierul există. Adică exact același mesaj ca pentru
// un id greșit, deși cauza e cu totul alta. `capabilities.canAddChildren`
// spune adevărul dinainte, iar `driveId` arată dacă folderul chiar e într-un
// Drive partajat sau, din greșeală, într-un My Drive.
async function info(id) {
  const token = await g.tokenDrive();
  const campuri = "id,name,mimeType,driveId,webViewLink,ownedByMe,capabilities(canAddChildren,canEdit,canListChildren)";
  const r = await g.apel("GET", `${FISIERE}/${encodeURIComponent(id)}?fields=${encodeURIComponent(campuri)}&${COMUN}`, { token });
  return r.json || {};
}

// Caută un subfolder după nume, iar dacă nu există îl creează. Se apelează
// des (o dată pe partener, pe lună), de-aia are cache: altfel s-ar face două
// cereri în plus pentru fiecare atașament.
const cacheFoldere = new Map();

async function folder(nume, parinte) {
  const cheie = `${parinte}/${nume}`;
  if (cacheFoldere.has(cheie)) return cacheFoldere.get(cheie);
  const token = await g.tokenDrive();
  const q = `name='${apostrof(nume)}' and '${apostrof(parinte)}' in parents and mimeType='${MIME_FOLDER}' and trashed=false`;
  const r = await g.apel("GET", `${FISIERE}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10&${COMUN}`, { token });
  const gasite = (r.json && r.json.files) || [];
  if (gasite.length) {
    cacheFoldere.set(cheie, gasite[0].id);
    return gasite[0].id;
  }
  const c = await g.apel("POST", `${FISIERE}?fields=id&${COMUN}`, {
    token,
    json: { name: nume, mimeType: MIME_FOLDER, parents: [parinte] },
  });
  const id = c.json && c.json.id;
  if (!id) throw new Error("Drive n-a întors id pentru folderul creat");
  cacheFoldere.set(cheie, id);
  return id;
}

// Creează o cale de foldere, bucată cu bucată: cale("ACME SRL/2026-09", rad)
async function cale(bucati, radacina) {
  let curent = radacina;
  for (const b of Array.isArray(bucati) ? bucati : String(bucati).split("/")) {
    const nume = curatNume(b);
    if (!nume) continue;
    curent = await folder(nume, curent);
  }
  return curent;
}

// Drive acceptă aproape orice în nume, dar un nume cu / sau cu rânduri noi
// face fișierul imposibil de găsit și de descărcat. Se curăță, păstrând
// diacriticele — sunt nume de firme românești, nu identificatori.
function curatNume(s) {
  return String(s || "")
    .replace(/[\/\\\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

// Același atașament trimis de cinci ori nu trebuie să facă cinci copii.
// Deduplicarea se face pe md5 — Drive îl calculează singur și îl întoarce, deci
// nu trebuie să ținem noi un index ca să fie corect.
async function dupaMd5(md5, parinte) {
  if (!md5) return null;
  const token = await g.tokenDrive();
  const q = `'${apostrof(parinte)}' in parents and trashed=false`;
  const r = await g.apel("GET", `${FISIERE}?q=${encodeURIComponent(q)}&fields=files(id,name,md5Checksum,webViewLink,size)&pageSize=1000&${COMUN}`, { token });
  const gasite = (r.json && r.json.files) || [];
  return gasite.find((f) => f.md5Checksum === md5) || null;
}

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

// Urcare simplă (multipart), potrivită pentru atașamente de email. Peste
// câteva zeci de megaocteți ar trebui urcare reluabilă, dar un atașament de
// email nu trece de 25 MB — limita Gmail — deci n-are rost complicația.
async function urca({ nume, mime, continut, parinte }) {
  const token = await g.tokenDrive();
  const amprenta = md5(continut);
  const existent = await dupaMd5(amprenta, parinte);
  if (existent) return { id: existent.id, nume: existent.name, link: existent.webViewLink || linkul(existent.id), md5: amprenta, marime: Number(existent.size || continut.length), duplicat: true };

  const granita = "erp" + crypto.randomBytes(12).toString("hex");
  const meta = JSON.stringify({ name: curatNume(nume) || "fisier", parents: [parinte] });
  const corp = Buffer.concat([
    Buffer.from(`--${granita}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`, "utf8"),
    Buffer.from(`--${granita}\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`, "utf8"),
    continut,
    Buffer.from(`\r\n--${granita}--\r\n`, "utf8"),
  ]);
  const r = await g.apel("POST", `${URCARE}?uploadType=multipart&fields=id,name,webViewLink,md5Checksum,size&${COMUN}`, {
    token,
    corp,
    antete: { "Content-Type": `multipart/related; boundary=${granita}` },
    timeout: 120000,
  });
  const j = r.json || {};
  if (!j.id) throw new Error("Drive n-a întors id pentru fișierul urcat");
  return { id: j.id, nume: j.name || nume, link: j.webViewLink || linkul(j.id), md5: j.md5Checksum || amprenta, marime: Number(j.size || continut.length), duplicat: false };
}

function linkul(id) {
  return `https://drive.google.com/file/d/${id}/view`;
}

async function sterge(id) {
  const token = await g.tokenDrive();
  await g.apel("DELETE", `${FISIERE}/${encodeURIComponent(id)}?${COMUN}`, { token });
}

function reseteaza() {
  cacheFoldere.clear();
}

module.exports = { info, folder, cale, dupaMd5, urca, sterge, linkul, md5, curatNume, reseteaza };
