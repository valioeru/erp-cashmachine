"use strict";
// Trimitere de emailuri direct din CRM, prin contul de email al fiecărui
// utilizator (SMTP). Scris pe modulele native ale Node (`net`, `tls`,
// `crypto`) — fără nicio dependință externă, ca restul aplicației.
//
// De ce contul fiecărui agent și nu unul comun: un email de vânzare trebuie
// să plece de la adresa agentului care ține relația, ca răspunsul clientului
// să ajungă la el, nu într-o căsuță comună pe care n-o citește nimeni.
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

// --- cifrarea parolei SMTP -------------------------------------------------
// Parola contului de email NU se ține în clar în baza de date. E cifrată cu
// AES-256-GCM, cu o cheie derivată dintr-un secret de mediu. Dacă secretul
// lipsește, derivăm din DATABASE_URL — stabil pentru instanța curentă, dar
// atunci un dump al bazei împreună cu variabilele de mediu ar fi suficient
// pentru decriptare, deci pe producție setează APP_SECRET.
function cheie() {
  const secret = process.env.APP_SECRET || process.env.DATABASE_URL || "erp-secret-implicit";
  return crypto.scryptSync(secret, "erp-smtp-v1", 32);
}

function cifreaza(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cheie(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

function descifreaza(pachet) {
  if (!pachet) return null;
  try {
    const [ivB64, tagB64, dataB64] = String(pachet).split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", cheie(), Buffer.from(ivB64, "base64"));
    d.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8");
  } catch (e) {
    // Cheie schimbată sau date corupte — tratăm ca "parolă lipsă", nu crăpăm.
    return null;
  }
}

// --- preseturi pentru furnizorii uzuali ------------------------------------
const PRESETURI = {
  "gmail.com": { host: "smtp.gmail.com", port: 587, nota: "Gmail cere o „parolă de aplicație”, nu parola contului (Google Account → Securitate → Parole pentru aplicații)." },
  "googlemail.com": { host: "smtp.gmail.com", port: 587, nota: "Gmail cere o „parolă de aplicație”." },
  "outlook.com": { host: "smtp-mail.outlook.com", port: 587, nota: "Microsoft 365 / Outlook cere de obicei o parolă de aplicație dacă ai 2FA activat." },
  "hotmail.com": { host: "smtp-mail.outlook.com", port: 587, nota: "" },
  "office365.com": { host: "smtp.office365.com", port: 587, nota: "" },
  "yahoo.com": { host: "smtp.mail.yahoo.com", port: 587, nota: "Yahoo cere parolă de aplicație." },
};

function presetPentru(email) {
  const domeniu = String(email || "").split("@")[1];
  if (!domeniu) return null;
  return PRESETURI[domeniu.toLowerCase()] || null;
}

// --- client SMTP minimal ---------------------------------------------------
// Suportă STARTTLS (portul 587, cazul obișnuit), TLS implicit (465) și AUTH
// LOGIN / PLAIN.
function conversatie(socket, timeoutMs) {
  let buffer = "";
  const asteptari = [];
  let eroareFatala = null;

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    // Un răspuns SMTP e complet când ultima linie are forma "250 text"
    // (spațiu după cod), nu "250-text" (continuare).
    let idx;
    while ((idx = gasesteRaspunsComplet(buffer)) !== -1) {
      const raspuns = buffer.slice(0, idx);
      buffer = buffer.slice(idx);
      const a = asteptari.shift();
      if (a) a.resolve(raspuns.trim());
    }
  });
  const respinge = (e) => {
    eroareFatala = e;
    while (asteptari.length) asteptari.shift().reject(e);
  };
  socket.on("error", respinge);
  socket.on("close", () => respinge(new Error("Conexiunea SMTP s-a închis neașteptat.")));

  return {
    citeste() {
      if (eroareFatala) return Promise.reject(eroareFatala);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Serverul de email nu a răspuns la timp.")), timeoutMs);
        asteptari.push({
          resolve: (v) => {
            clearTimeout(t);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
      });
    },
    scrie(linie) {
      socket.write(linie + "\r\n");
    },
  };
}

function gasesteRaspunsComplet(buffer) {
  const linii = buffer.split("\r\n");
  let pozitie = 0;
  for (let i = 0; i < linii.length - 1; i++) {
    pozitie += linii[i].length + 2;
    if (/^\d{3} /.test(linii[i])) return pozitie;
  }
  return -1;
}

function verificaCod(raspuns, asteptat, pas) {
  const cod = parseInt(String(raspuns).slice(0, 3), 10);
  const ok = Array.isArray(asteptat) ? asteptat.includes(cod) : cod === asteptat;
  if (!ok) throw new Error(`Serverul de email a refuzat pasul „${pas}”: ${String(raspuns).split("\r\n")[0]}`);
}

// Codifică un antet cu diacritice conform RFC 2047, ca subiectul să nu ajungă
// mutilat în inbox.
function antet(valoare) {
  const s = String(valoare || "");
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

async function trimite(config, mesaj) {
  const { host, port, user, parola, expeditor, numeExpeditor, securizare } = config;
  if (!host || !port || !expeditor) throw new Error("Contul de email nu e configurat complet (server, port, adresă).");
  const timeoutMs = 20000;
  // Tipul de criptare vine din setările contului. Dacă lipsește (conturi
  // salvate înainte de introducerea opțiunii), îl deducem din port: 465
  // înseamnă TLS direct, orice altceva STARTTLS. Ghicitul după port singur
  // nu e suficient — sunt servere care oferă TLS direct pe porturi
  // nestandard, iar atunci clientul ar vorbi în clar cu un server criptat
  // și ar aștepta la infinit un răspuns care nu vine.
  const implicitTls = securizare ? securizare === "tls" : Number(port) === 465;

  let socket = implicitTls
    ? tls.connect({ host, port: Number(port), servername: host })
    : net.connect({ host, port: Number(port) });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Nu m-am putut conecta la ${host}:${port} (timeout).`)), timeoutMs);
    socket.once(implicitTls ? "secureConnect" : "connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(t);
      reject(new Error(`Nu m-am putut conecta la ${host}:${port} — ${e.message}`));
    });
  });

  let c = conversatie(socket, timeoutMs);
  verificaCod(await c.citeste(), 220, "salut inițial");

  c.scrie("EHLO erp.local");
  let ehlo = await c.citeste();
  verificaCod(ehlo, 250, "EHLO");

  if (!implicitTls) {
    if (!/STARTTLS/i.test(ehlo)) throw new Error("Serverul nu acceptă conexiune criptată (STARTTLS). Din motive de securitate nu trimitem parola pe o conexiune necriptată.");
    c.scrie("STARTTLS");
    verificaCod(await c.citeste(), 220, "STARTTLS");
    socket = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket, servername: host }, () => resolve(s));
      s.once("error", reject);
    });
    c = conversatie(socket, timeoutMs);
    c.scrie("EHLO erp.local");
    ehlo = await c.citeste();
    verificaCod(ehlo, 250, "EHLO după STARTTLS");
  }

  if (user && parola) {
    if (/AUTH[^\r\n]*LOGIN/i.test(ehlo)) {
      c.scrie("AUTH LOGIN");
      verificaCod(await c.citeste(), 334, "AUTH LOGIN");
      c.scrie(Buffer.from(user, "utf8").toString("base64"));
      verificaCod(await c.citeste(), 334, "utilizator");
      c.scrie(Buffer.from(parola, "utf8").toString("base64"));
      verificaCod(await c.citeste(), 235, "autentificare");
    } else {
      const token = Buffer.from(`\0${user}\0${parola}`, "utf8").toString("base64");
      c.scrie(`AUTH PLAIN ${token}`);
      verificaCod(await c.citeste(), 235, "autentificare");
    }
  }

  c.scrie(`MAIL FROM:<${expeditor}>`);
  verificaCod(await c.citeste(), 250, "expeditor");

  const destinatari = [...(mesaj.catre || []), ...(mesaj.cc || [])].filter(Boolean);
  if (!destinatari.length) throw new Error("Nu ai completat niciun destinatar.");
  for (const d of destinatari) {
    c.scrie(`RCPT TO:<${d}>`);
    verificaCod(await c.citeste(), [250, 251], `destinatar ${d}`);
  }

  c.scrie("DATA");
  verificaCod(await c.citeste(), 354, "DATA");

  const corp = String(mesaj.corp || "");
  const antete = [
    `From: ${numeExpeditor ? `${antet(numeExpeditor)} <${expeditor}>` : expeditor}`,
    `To: ${(mesaj.catre || []).join(", ")}`,
    mesaj.cc && mesaj.cc.length ? `Cc: ${mesaj.cc.join(", ")}` : null,
    `Subject: ${antet(mesaj.subiect)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@erp.local>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ]
    .filter(Boolean)
    .join("\r\n");

  // base64 pe 76 de caractere → scapă complet de problema liniilor care încep
  // cu punct (dot-stuffing) și de limita de lungime a liniei din SMTP.
  const corpB64 = Buffer.from(corp, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  socket.write(antete + "\r\n\r\n" + corpB64 + "\r\n.\r\n");
  verificaCod(await c.citeste(), 250, "trimitere mesaj");

  c.scrie("QUIT");
  socket.end();
  return true;
}

// Config-ul de email al unui utilizator, gata de folosit (parola descifrată).
function configUtilizator(u) {
  if (!u || !u.smtp_host || !u.email_expeditor) return null;
  return {
    host: u.smtp_host,
    port: u.smtp_port || 587,
    user: u.smtp_user || u.email_expeditor,
    parola: descifreaza(u.smtp_parola_cifrata),
    expeditor: u.email_expeditor,
    numeExpeditor: u.nume,
    securizare: u.smtp_securizare || null,
  };
}

module.exports = { trimite, cifreaza, descifreaza, configUtilizator, presetPentru, PRESETURI };
