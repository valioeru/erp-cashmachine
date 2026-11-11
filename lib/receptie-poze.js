"use strict";
// Pozele unei recepții: marfa cum a venit, avizul, factura, CMR-ul.
//
// CE A CERUT VALI, 11.11.2026: „La recepție să se poată adăuga o poză cu
// produs, cu aviz etc., momentan va fi opțională, poza o vei urca în Drive."
//
// UNDE STAU. În Drive, nu în baza ERP-ului — aceeași hotărâre ca la pozele
// retururilor din fulfillment („salveaz-o în Drive, ca să nu se încarce baza
// pe Render"). În bază rămâne doar rândul: a cui recepție e, ce e în poză,
// cine a pus-o, când, și legătura spre fișier. Folderul:
//   <folderul ERP-ului din Drive> / Recepții / <an-lună> / <numărul recepției>
//
// DACĂ DRIVE NU RĂSPUNDE, poza nu se pierde: avizul pleacă cu șoferul și nu
// mai poate fi pozat a doua oară. Rămâne în baza ERP-ului, iar pagina o spune
// pe față — altfel ar părea că a ajuns în Drive.
//
// Pozele vin micșorate din browser (1600 px, JPEG), câte un câmp ascuns
// `poza_date_<n>` pentru fiecare; fără JavaScript vin ca fișiere, în `poze`.
// Aici nu e nimic despre pagină: doar ce se primește, ce se refuză și unde
// se pune.
const drive = require("./drive");

// Ce e în poză. Primul e cel ales din oficiu.
const FELURI = [
  ["marfa", "marfa"],
  ["aviz", "avizul"],
  ["factura", "factura"],
  ["cmr", "CMR / transport"],
  ["altceva", "altceva"],
];
const MAX_OCTETI = 8 * 1024 * 1024;
const MAX_POZE = 12;

const felCurat = (v) => (FELURI.some(([c]) => c === String(v || "")) ? String(v) : FELURI[0][0]);
const etichetaFel = (v) => (FELURI.find(([c]) => c === String(v || "")) || [, "poză"])[1];
const extensie = (mime) => (/png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : /heic|heif/i.test(mime) ? "heic" : "jpg");
const mb = (n) => Math.round(n / 104857.6) / 10;

// „data:image/jpeg;base64,…" → { mime, octeti }. Orice altceva e refuzat: un
// câmp ascuns poate fi scris de oricine, deci nu se ia de bun.
function dinDataUrl(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("data:")) return null;
  const virgula = t.indexOf(",");
  if (virgula < 0) return null;
  const antet = t.slice(5, virgula);
  const bucati = antet.split(";");
  const mime = String(bucati[0] || "").toLowerCase();
  if (!mime.startsWith("image/") || !bucati.includes("base64")) return null;
  const corp = t.slice(virgula + 1);
  if (!corp || /[^A-Za-z0-9+/=\s]/.test(corp)) return null;
  const octeti = Buffer.from(corp, "base64");
  return octeti.length ? { mime, octeti } : null;
}

// Tot ce a venit din formular, verificat. O singură poză greșită oprește
// trimiterea, cu motivul — nu se urcă jumătate și se tace despre rest.
function adunaPoze(body) {
  const b = body || {};
  const poze = [];
  const chei = Object.keys(b)
    .filter((k) => /^poza_date_\d+$/.test(k))
    .sort((x, y) => Number(x.slice(10)) - Number(y.slice(10)));
  for (const k of chei) {
    if (!String(b[k] || "").trim()) continue;
    const p = dinDataUrl(b[k]);
    if (!p) return { eroare: "O poză n-a ajuns întreagă. Încearcă din nou." };
    poze.push(p);
  }
  const fisiere = (b.__files && b.__files.poze) || [];
  for (const f of fisiere) {
    if (!f || !f.data || !f.data.length) continue;
    const mime = String(f.contentType || "").toLowerCase();
    if (!mime.startsWith("image/")) return { eroare: `„${f.filename || "fișierul"}” nu e o poză.` };
    poze.push({ mime, octeti: f.data, nume: f.filename || "" });
  }
  for (const p of poze) {
    if (p.octeti.length > MAX_OCTETI) return { eroare: `O poză are ${mb(p.octeti.length)} MB, prea mult (cel mult ${mb(MAX_OCTETI)} MB). Fă-o din nou — pe telefon se micșorează singură.` };
  }
  if (poze.length > MAX_POZE) return { eroare: `Sunt ${poze.length} poze; se urcă cel mult ${MAX_POZE} odată. Trimite-le în două rânduri.` };
  return { poze };
}

// Ora României, ca pe restul paginilor din depozit.
const acumRo = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19);

// Numele fișierului din Drive: se înțelege și fără ERP — a cui recepție, ce e
// în poză, când.
function numeFisier(receptie, fel, mime, index, cand) {
  const numar = String((receptie && (receptie.numar || "REC-" + receptie.id)) || "receptie").replace(/[^A-Za-z0-9._-]+/g, "-");
  const clipa = String(cand || acumRo()).replace(/[^0-9]+/g, "-").replace(/-+$/, "");
  return `${numar}_${felCurat(fel)}_${clipa}_${Number(index) + 1}.${extensie(mime)}`;
}

// Folderul recepției în Drive.
async function folderReceptie(receptie, cand) {
  const radacina = process.env.GOOGLE_DRIVE_FOLDER;
  if (!radacina) throw new Error("GOOGLE_DRIVE_FOLDER nu e setată în Render");
  const luna = String(cand || acumRo()).slice(0, 7);
  const eticheta = [receptie.numar || "Recepția " + receptie.id, receptie.partener].filter(Boolean).join(" · ");
  return drive.cale(["Recepții", luna, eticheta], radacina);
}

// Pune poza în Drive. Întoarce ce se scrie în bază: legătura, id-ul din Drive,
// numele și mărimea. Dacă Drive nu răspunde, legătura e chiar poza (data-URL)
// și `inDrive` e false, cu motivul.
async function pastreaza(receptie, poza, { fel, index, cand } = {}) {
  const clipa = cand || acumRo();
  const nume = numeFisier(receptie, fel, poza.mime, index || 0, clipa);
  try {
    const parinte = await folderReceptie(receptie, clipa);
    const rez = await drive.urca({ nume, mime: poza.mime, continut: poza.octeti, parinte });
    return { inDrive: true, link: rez.link, driveId: rez.id, nume: rez.nume || nume, marime: poza.octeti.length, duplicat: Boolean(rez.duplicat) };
  } catch (e) {
    return {
      inDrive: false,
      link: `data:${poza.mime};base64,${poza.octeti.toString("base64")}`,
      driveId: null,
      nume,
      marime: poza.octeti.length,
      duplicat: false,
      motiv: String((e && e.message) || e).slice(0, 120),
    };
  }
}

module.exports = { FELURI, MAX_OCTETI, MAX_POZE, felCurat, etichetaFel, dinDataUrl, adunaPoze, numeFisier, folderReceptie, pastreaza, acumRo };
