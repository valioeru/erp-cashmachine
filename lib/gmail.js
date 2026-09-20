"use strict";
// Citirea și trimiterea prin Gmail API, cu identitatea fiecărei căsuțe
// (impersonare prin service account).
//
// Cele două drumuri au scope-uri separate, dinadins:
//   - citirea merge pe gmail.readonly — nu poate trimite, nu poate șterge, nu
//     poate marca citit;
//   - trimiterea merge pe gmail.send — nu poate citi absolut nimic.
// Chiar dacă cineva greșește configurarea din Workspace Admin, cele două nu se
// pot amesteca.
//
// De ce prin Gmail și nu prin SMTP: mesajul ajunge în folderul Trimise al
// omului (pe SMTP nu ajunge), semnătura DKIM e a domeniului deci nu intră în
// spam, și nu mai trebuie ținută nicio parolă pe fișa niciunui utilizator.
// SMTP-ul din lib/mail.js rămâne ca rezervă, pentru adresele din afara
// domeniului și pentru cazul în care Google nu e configurat.
const crypto = require("crypto");
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


// --- trimiterea ------------------------------------------------------------

// Un antet de email are voie să conțină doar ASCII. „Ofertă preț țeavă" n-are
// ce căuta acolo brut — se codează RFC 2047, altfel subiectul ajunge la
// destinatar ca „OfertÄƒ preÈ›".
function antetCodat(valoare) {
  const v = String(valoare == null ? "" : valoare).replace(/[\r\n]+/g, " ").trim();
  if (!v) return "";
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  return "=?UTF-8?B?" + Buffer.from(v, "utf8").toString("base64") + "?=";
}

// „Ion Popescu <ion@firma.ro>".
//
// Numele are trei drumuri, după ce conține:
//   - doar litere și spații → se pune ca atare;
//   - diacritice → se codează RFC 2047 (codarea îl face și sigur, fiind base64);
//   - caractere cu înțeles în antet — : @ < > , ; " ( ) [ ] \ — → se pune între
//     ghilimele, cu ghilimelele și backslash-urile din el escapate.
// Fără al treilea caz, un nume ca „Cineva Bcc: x@y.ro" ieșea nequotat și lăsa
// caracterele alea în antetul From. Niciun client serios nu le-ar fi citit ca
// destinatari — antetul rămâne un singur rând — dar un antet care nu respectă
// gramatica e exact felul de lucru care se sparge la al treilea client de
// email, în producție, fără să știi de ce.
const SPECIALE = /[()<>\[\]:;@\\,."]/;

function adresaCuNume(nume, email) {
  const e = String(email || "").trim();
  const n = String(nume || "").replace(/[\r\n]+/g, " ").trim();
  if (!n) return e;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7E]*$/.test(n)) return `${antetCodat(n)} <${e}>`;
  if (SPECIALE.test(n)) return `"${n.replace(/([\\"])/g, "\\$1")}" <${e}>`;
  return `${n} <${e}>`;
}

function granita() {
  return "erp" + crypto.randomBytes(12).toString("hex");
}

// base64 pe 76 de caractere, cum cere MIME.
function b64(buf) {
  return Buffer.from(buf).toString("base64").replace(/(.{76})/g, "$1\r\n");
}

// Construiește mesajul RFC 2822. Fără atașamente iese un mesaj simplu; cu
// atașamente, un multipart/mixed. Nu mergem mai departe de atât: un email de
// ofertă are text și fișiere, nu galerii inline.
function construieste(mesaj) {
  const catre = (mesaj.catre || []).filter(Boolean);
  const cc = (mesaj.cc || []).filter(Boolean);
  const atasamente = (mesaj.atasamente || []).filter((a) => a && a.continut);
  const corp = String(mesaj.corp || "");
  const tipCorp = mesaj.html ? "text/html" : "text/plain";

  const antete = [
    `From: ${adresaCuNume(mesaj.numeExpeditor, mesaj.deLa)}`,
    `To: ${catre.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : null,
    mesaj.raspundeLa ? `Reply-To: ${mesaj.raspundeLa}` : null,
    `Subject: ${antetCodat(mesaj.subiect)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (!atasamente.length) {
    antete.push(`Content-Type: ${tipCorp}; charset="UTF-8"`, "Content-Transfer-Encoding: base64");
    return antete.join("\r\n") + "\r\n\r\n" + b64(Buffer.from(corp, "utf8")) + "\r\n";
  }

  const gr = granita();
  antete.push(`Content-Type: multipart/mixed; boundary="${gr}"`);
  const parti = [
    `--${gr}\r\nContent-Type: ${tipCorp}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(corp, "utf8"))}\r\n`,
  ];
  for (const a of atasamente) {
    const nume = String(a.nume || "fisier").replace(/[\r\n"]+/g, " ").trim() || "fisier";
    parti.push(
      `--${gr}\r\n` +
        `Content-Type: ${a.mime || "application/octet-stream"}; name="${nume}"\r\n` +
        `Content-Disposition: attachment; filename="${nume}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        b64(a.continut) +
        "\r\n"
    );
  }
  return antete.join("\r\n") + "\r\n\r\n" + parti.join("") + `--${gr}--\r\n`;
}

// Trimite din căsuța `deLa`, cu identitatea ei. Mesajul ajunge în Trimise la
// ea, exact ca și cum l-ar fi scris omul din Gmail.
async function trimite(deLa, mesaj) {
  const adresaDeLa = String(deLa || "").trim();
  if (!adresaDeLa) throw new Error("Nu știu din ce căsuță să trimit.");
  const catre = (mesaj.catre || []).filter(Boolean);
  if (!catre.length) throw new Error("Nu ai completat niciun destinatar.");

  const token = await g.tokenGmailTrimite(adresaDeLa);
  const brut = construieste(Object.assign({}, mesaj, { deLa: adresaDeLa }));
  const raw = Buffer.from(brut, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await g.apel("POST", `${BAZA}/${enc(adresaDeLa)}/messages/send`, {
    token,
    casuta: adresaDeLa,
    json: { raw },
    timeout: 60000,
  });
  const j = r.json || {};
  return { id: j.id || "", firId: j.threadId || "" };
}

// Verifică doar că Google ar da voie să se trimită din căsuța asta. NU trimite
// nimic: cere un token cu scope-ul de trimitere și se oprește acolo. Pagina de
// verificare are nevoie de răspunsul ăsta fără să trezească pe nimeni cu un
// email de probă în inbox.
async function poateTrimite(casuta) {
  await g.tokenGmailTrimite(String(casuta || "").trim());
  return true;
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
  trimite,
  poateTrimite,
  construieste,
  antetCodat,
};
