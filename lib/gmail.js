"use strict";
// Citirea căsuțelor Gmail prin API, cu identitatea fiecărei căsuțe
// (impersonare prin service account). Doar citire: scope-ul e gmail.readonly,
// deci ERP-ul nu poate șterge un mesaj, nu-l poate marca citit și nu poate
// trimite nimic. Trimiterea rămâne pe SMTP-ul din lib/mail.js.
const g = require("./google");

const BAZA = "https://gmail.googleapis.com/gmail/v1/users";
const enc = encodeURIComponent;

// --- listare ---------------------------------------------------------------
// Două feluri de citire, fiindcă sunt două situații diferite:
//   - prima dată pe o căsuță nu există istoric de la care să pornești, deci se
//     ia o felie de timp (ultimele N zile) prin căutare;
//   - după aceea Gmail ține un „historyId" — un contor al schimbărilor — și
//     poți cere doar ce s-a întâmplat de atunci. E de zeci de ori mai ieftin
//     și, mai important, nu pierde mesaje între două rulări.
async function listeazaDupaCautare(casuta, cautare, maxim) {
  const token = await g.tokenGmail(casuta);
  const iduri = [];
  let pagina = "";
  while (iduri.length < (maxim || 500)) {
    const url = `${BAZA}/${enc(casuta)}/messages?maxResults=100&q=${enc(cautare || "")}${pagina ? `&pageToken=${enc(pagina)}` : ""}`;
    const r = await g.apel("GET", url, { token, casuta });
    const j = r.json || {};
    for (const m of j.messages || []) iduri.push(m.id);
    pagina = j.nextPageToken || "";
    if (!pagina) break;
  }
  return iduri.slice(0, maxim || 500);
}

// Întoarce { iduri, historyId, pierdut } — „pierdut" înseamnă că Gmail nu mai
// știe istoricul de la punctul cerut (se întâmplă după câteva zile de pauză
// sau după o curățenie mare în căsuță). Nu e o eroare: e semnalul că trebuie
// reluată citirea pe felie de timp, altfel s-ar sări peste mesaje în tăcere.
async function listeazaDupaIstoric(casuta, deLaHistoryId) {
  const token = await g.tokenGmail(casuta);
  const iduri = new Set();
  let pagina = "";
  let ultimHistoryId = String(deLaHistoryId || "");
  for (let i = 0; i < 50; i++) {
    const url = `${BAZA}/${enc(casuta)}/history?startHistoryId=${enc(String(deLaHistoryId))}&historyTypes=messageAdded&maxResults=500${pagina ? `&pageToken=${enc(pagina)}` : ""}`;
    const r = await g.cerere("GET", url, { token });
    if (r.cod === 404) return { iduri: [], historyId: "", pierdut: true };
    if (r.cod < 200 || r.cod >= 300) throw new Error(g.explica(r, casuta));
    const j = r.json || {};
    for (const h of j.history || []) for (const x of h.messagesAdded || []) if (x.message && x.message.id) iduri.add(x.message.id);
    if (j.historyId) ultimHistoryId = String(j.historyId);
    pagina = j.nextPageToken || "";
    if (!pagina) break;
  }
  return { iduri: [...iduri], historyId: ultimHistoryId, pierdut: false };
}

async function profil(casuta) {
  const token = await g.tokenGmail(casuta);
  const r = await g.apel("GET", `${BAZA}/${enc(casuta)}/profile`, { token, casuta });
  const j = r.json || {};
  return { adresa: j.emailAddress || casuta, mesaje: Number(j.messagesTotal || 0), fire: Number(j.threadsTotal || 0), historyId: String(j.historyId || "") };
}

// --- un mesaj --------------------------------------------------------------
function antet(incarcatura, nume) {
  const h = (incarcatura && incarcatura.headers) || [];
  const gasit = h.find((x) => String(x.name || "").toLowerCase() === String(nume).toLowerCase());
  return gasit ? String(gasit.value || "") : "";
}

function dinBase64Url(s) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Un mesaj Gmail e un arbore de părți: text simplu, HTML, atașamente, și
// uneori aceleași lucruri împachetate de încă două ori. Se umblă tot arborele
// o singură dată și se strânge ce ne trebuie.
function despacheteaza(parte, adunate) {
  if (!parte) return adunate;
  const tip = String(parte.mimeType || "");
  const numeFisier = String(parte.filename || "");
  const corp = parte.body || {};

  if (numeFisier && corp.attachmentId) {
    adunate.atasamente.push({
      nume: numeFisier,
      mime: tip,
      marime: Number(corp.size || 0),
      atasamentId: String(corp.attachmentId),
      // un atașament inline (o semnătură cu poză, un logo) nu e un document,
      // e decor. Se marchează, ca să nu umple Drive-ul cu logo-uri.
      inline: /inline/i.test(antet(parte, "Content-Disposition")) || !!antet(parte, "Content-ID"),
    });
  } else if (tip === "text/plain" && corp.data && !numeFisier) {
    adunate.text += dinBase64Url(corp.data).toString("utf8");
  } else if (tip === "text/html" && corp.data && !numeFisier) {
    adunate.html += dinBase64Url(corp.data).toString("utf8");
  }

  for (const p of parte.parts || []) despacheteaza(p, adunate);
  return adunate;
}

function textDinHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function mesaj(casuta, id) {
  const token = await g.tokenGmail(casuta);
  const r = await g.apel("GET", `${BAZA}/${enc(casuta)}/messages/${enc(id)}?format=full`, { token, casuta });
  const j = r.json || {};
  const p = j.payload || {};
  const adunate = despacheteaza(p, { text: "", html: "", atasamente: [] });
  const text = adunate.text.trim() || textDinHtml(adunate.html);
  return {
    id: String(j.id || id),
    firId: String(j.threadId || ""),
    historyId: String(j.historyId || ""),
    // internalDate e în milisecunde, ca șir. E data la care Gmail a primit
    // mesajul — de încredere. Antetul Date e scris de expeditor și poate fi
    // orice, inclusiv anul 1970.
    data: j.internalDate ? new Date(Number(j.internalDate)).toISOString() : "",
    etichete: (j.labelIds || []).join(","),
    snippet: String(j.snippet || ""),
    de_la: antet(p, "From"),
    catre: antet(p, "To"),
    cc: antet(p, "Cc"),
    raspunde_la: antet(p, "Reply-To"),
    subiect: antet(p, "Subject"),
    messageId: antet(p, "Message-ID"),
    text,
    html: adunate.html,
    atasamente: adunate.atasamente,
  };
}

async function atasament(casuta, mesajId, atasamentId) {
  const token = await g.tokenGmail(casuta);
  const r = await g.apel("GET", `${BAZA}/${enc(casuta)}/messages/${enc(mesajId)}/attachments/${enc(atasamentId)}`, { token, casuta });
  const j = r.json || {};
  if (!j.data) throw new Error("atașamentul n-a venit cu conținut");
  return dinBase64Url(j.data);
}

// --- ajutoare de citit adrese ---------------------------------------------
// „Ion Popescu <ion@firma.ro>" → { nume: "Ion Popescu", adresa: "ion@firma.ro" }
function adresa(brut) {
  const s = String(brut || "").trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(s);
  if (m) return { nume: m[1].trim().replace(/^"|"$/g, ""), adresa: m[2].trim().toLowerCase() };
  return { nume: "", adresa: s.toLowerCase() };
}

function adrese(brut) {
  return String(brut || "")
    .split(/,(?![^<]*>)/)
    .map((x) => adresa(x))
    .filter((x) => x.adresa);
}

function domeniu(email) {
  const a = String(email || "").toLowerCase();
  const i = a.lastIndexOf("@");
  return i > 0 ? a.slice(i + 1) : "";
}

module.exports = {
  listeazaDupaCautare,
  listeazaDupaIstoric,
  profil,
  mesaj,
  atasament,
  adresa,
  adrese,
  domeniu,
  textDinHtml,
  despacheteaza,
  antet,
};
