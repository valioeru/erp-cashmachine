"use strict";
// Test pentru trimiterea prin Gmail API și pentru ordinea Gmail → SMTP.
//
// De ce există: până acum ERP-ul trimitea doar pe SMTP, cu parola fiecărui om
// ținută pe fișa lui. Prin Gmail nu mai trebuie nicio parolă, mesajul ajunge
// în Trimise la omul care l-a trimis, iar semnătura DKIM e a domeniului — deci
// nu mai aterizează în spam.
//
// Ce se verifică aici sunt exact lucrurile care se strică tăcut:
//   - un subiect cu diacritice trebuie codat RFC 2047, altfel clientul primește
//     „OfertÄƒ preÈ›" și noi n-avem de unde ști;
//   - un rând nou strecurat în subiect sau în nume înseamnă antet injectat —
//     cu el se pot adăuga destinatari nevăzuți;
//   - atașamentele trebuie să iasă multipart/mixed, cu numele pe fișier;
//   - dacă Gmail refuză, mesajul TREBUIE să încerce SMTP-ul înainte de a
//     raporta eșec. Omul care apasă „Trimite" vrea ca emailul să plece, nu să
//     afle pe ce drum a plecat.
//
// Nu atinge rețeaua: funcțiile de construit mesajul sunt pure, iar trimiterea
// se testează cu Gmail-ul înlocuit de o păcăleală.
const path = require("path");
const Module = require("module");

const RAD = __dirname;
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};

const gmail = require(path.join(RAD, "lib", "gmail.js"));
const google = require(path.join(RAD, "lib", "google.js"));
// mail.js cere ./gmail și ./google — primește exact obiectele de mai sus, din
// cache-ul lui require. Deci ce le schimbăm aici se vede și acolo.
const mail = require(path.join(RAD, "lib", "mail.js"));

let rele = 0;
function cere(ce, text, treb, interzis) {
  const lipsa = (treb || []).filter((t) => !text.includes(t));
  const gasite = (interzis || []).filter((t) => text.includes(t));
  if (lipsa.length || gasite.length) {
    rele++;
    console.log("  PROBLEMĂ " + ce +
      (lipsa.length ? ": lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : ": ") + "apare „" + gasite.join("”, „") + "”" : ""));
  } else console.log("  ok       " + ce);
}
function egal(ce, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) { rele++; console.log("  PROBLEMĂ " + ce + ": am " + a + ", așteptam " + b); }
  else console.log("  ok       " + ce + " = " + b);
}
const b64dec = (s) => Buffer.from(String(s).replace(/\r?\n/g, ""), "base64").toString("utf8");

console.log("Trimiterea prin Gmail\n");

// --- 1. antetele -----------------------------------------------------------
egal("subiect ASCII rămâne neatins", gmail.antetCodat("Oferta 1234"), "Oferta 1234");
cere("subiect cu diacritice se codează RFC 2047",
  gmail.antetCodat("Ofertă preț țeavă"), ["=?UTF-8?B?", "?="], ["ț"]);
egal("subiectul codat se decodează înapoi corect",
  Buffer.from(gmail.antetCodat("Ofertă preț țeavă").replace("=?UTF-8?B?", "").replace("?=", ""), "base64").toString("utf8"),
  "Ofertă preț țeavă");
egal("rândurile noi din subiect se strivesc",
  gmail.antetCodat("Oferta\r\nBcc: cineva@altundeva.ro"), "Oferta Bcc: cineva@altundeva.ro");
egal("subiect gol nu strică nimic", gmail.antetCodat(null), "");

// --- 2. mesajul simplu -----------------------------------------------------
const simplu = gmail.construieste({
  deLa: "vali@cashmachine.ro",
  numeExpeditor: "Valentin Oeru",
  catre: ["client@acme.ro"],
  cc: ["coleg@cashmachine.ro"],
  raspundeLa: "office@cashmachine.ro",
  subiect: "Ofertă preț",
  corp: "Bună ziua,\r\n\r\nVă trimit prețul cerut.\r\n\r\nO zi bună!",
});
cere("mesaj simplu: antetele obligatorii", simplu, [
  "From: Valentin Oeru <vali@cashmachine.ro>",
  "To: client@acme.ro",
  "Cc: coleg@cashmachine.ro",
  "Reply-To: office@cashmachine.ro",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: base64",
], ["multipart"]);
cere("mesaj simplu: corpul e base64, nu text brut", simplu, [], ["Vă trimit prețul cerut"]);
const corpSimplu = b64dec(simplu.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
cere("corpul se decodează cu diacritice întregi", corpSimplu, ["Vă trimit prețul cerut", "O zi bună!"], []);

// --- 3. numele expeditorului cu diacritice --------------------------------
const cuNume = gmail.construieste({
  deLa: "gabriela@cashmachine.ro", numeExpeditor: "Gabriela Tecuceanu",
  catre: ["x@y.ro"], subiect: "test", corp: "text",
});
cere("nume ASCII rămâne citibil", cuNume, ["From: Gabriela Tecuceanu <gabriela@cashmachine.ro>"], []);
const cuNumeRo = gmail.construieste({
  deLa: "a@b.ro", numeExpeditor: "Ștefan Mureșan", catre: ["x@y.ro"], subiect: "t", corp: "c",
});
cere("nume cu diacritice se codează", cuNumeRo, ["=?UTF-8?B?", "<a@b.ro>"], ["Ștefan Mureșan <"]);

// --- 4. injecția de antete -------------------------------------------------
const injectat = gmail.construieste({
  deLa: "a@b.ro",
  numeExpeditor: "Cineva\r\nBcc: spion@altundeva.ro",
  catre: ["x@y.ro"],
  subiect: "Salut\nBcc: spion2@altundeva.ro",
  corp: "text",
});
const anteteInjectat = injectat.split("\r\n\r\n")[0];
const randuri = anteteInjectat.split("\r\n");
// Ce contează nu e că textul „Bcc:" dispare — el poate rămâne, inofensiv, în
// interiorul unui nume. Ce contează e să nu devină NICIODATĂ un antet: adică
// să nu înceapă niciun rând cu el.
egal("niciun rând nu devine Bcc", randuri.filter((l) => /^Bcc:/i.test(l)).length, 0);
egal("niciun rând nu devine To în plus", randuri.filter((l) => /^To:/i.test(l)).length, 1);
egal("From-ul rămâne un singur rând", randuri.filter((l) => /^From:/i.test(l)).length, 1);
cere("numele cu caractere speciale se pune între ghilimele",
  randuri.find((l) => /^From:/.test(l)), ['From: "Cineva Bcc: spion@altundeva.ro" <a@b.ro>'], []);
cere("subiectul rămâne pe rândul lui, fără antete noi",
  randuri.find((l) => /^Subject:/.test(l)), ["Salut Bcc: spion2@altundeva.ro"], []);

// --- 5. atașamente ---------------------------------------------------------
const cuFisier = gmail.construieste({
  deLa: "a@b.ro",
  catre: ["x@y.ro"],
  subiect: "Oferta atașată",
  corp: "Vezi atașamentul.",
  atasamente: [
    { nume: "Oferta 2026-09.pdf", mime: "application/pdf", continut: Buffer.from("%PDF-1.4 fals", "utf8") },
    { nume: "listă prețuri.csv", mime: "text/csv", continut: Buffer.from("produs,pret\nteava,10", "utf8") },
  ],
});
cere("cu atașamente: multipart/mixed", cuFisier, [
  "Content-Type: multipart/mixed; boundary=",
  'Content-Disposition: attachment; filename="Oferta 2026-09.pdf"',
  'Content-Disposition: attachment; filename="listă prețuri.csv"',
  "Content-Type: application/pdf",
  "Content-Type: text/csv",
], []);
const gr = (cuFisier.match(/boundary="([^"]+)"/) || [])[1];
egal("granița se închide corect", cuFisier.trimEnd().endsWith(`--${gr}--`), true);
egal("sunt exact două atașamente", (cuFisier.match(/Content-Disposition: attachment/g) || []).length, 2);
cere("conținutul atașamentului e base64, nu brut", cuFisier, [], ["%PDF-1.4 fals", "produs,pret"]);

// --- 6. html ---------------------------------------------------------------
cere("corpul HTML iese cu tipul lui",
  gmail.construieste({ deLa: "a@b.ro", catre: ["x@y.ro"], subiect: "t", corp: "<b>salut</b>", html: true }),
  ['Content-Type: text/html; charset="UTF-8"'], ["text/plain"]);

// --- 7. trimite() se apără de lipsuri --------------------------------------
(async () => {
  for (const [ce, deLa, mesaj, bucata] of [
    ["fără căsuță nu se trimite", "", { catre: ["x@y.ro"] }, "din ce căsuță"],
    ["fără destinatar nu se trimite", "a@b.ro", { catre: [] }, "destinatar"],
  ]) {
    try {
      await gmail.trimite(deLa, mesaj);
      rele++; console.log("  PROBLEMĂ " + ce + ": a trecut, deși n-ar fi trebuit");
    } catch (e) {
      cere(ce, e.message, [bucata], []);
    }
  }

  // --- 8. ordinea Gmail → SMTP ---------------------------------------------
  const contReal = google.cont;
  const trimiteReal = gmail.trimite;
  const VALI = { id: 1, nume: "Valentin Oeru", email: "vali@cashmachine.ro", email_expeditor: "vali@cashmachine.ro" };

  // 8a. Google configurat și Gmail acceptă → pleacă pe Gmail, SMTP nici atins
  google.cont = () => ({ ok: true, email: "erp-email@proiect.iam.gserviceaccount.com" });
  let primit = null;
  gmail.trimite = async (deLa, m) => { primit = { deLa, m }; return { id: "1", firId: "1" }; };
  let dus = await mail.trimiteDeLa(VALI, { catre: ["client@acme.ro"], subiect: "Salut", corp: "text" });
  egal("cu Google configurat, mesajul pleacă pe Gmail", dus.prin, "gmail");
  egal("pleacă din căsuța omului, nu din alta", primit && primit.deLa, "vali@cashmachine.ro");
  egal("numele expeditorului ajunge la Gmail", primit && primit.m.numeExpeditor, "Valentin Oeru");
  egal("destinatarul e cel cerut", primit && primit.m.catre, ["client@acme.ro"]);

  // 8b. Google neconfigurat, fără SMTP → mesaj limpede, nu o excepție seacă
  google.cont = () => ({ ok: false, eroare: "GOOGLE_SA_JSON nu e setată" });
  try {
    await mail.trimiteDeLa(VALI, { catre: ["x@y.ro"], subiect: "t", corp: "c" });
    rele++; console.log("  PROBLEMĂ fără Google și fără SMTP: a zis că a trimis");
  } catch (e) {
    cere("fără Google și fără SMTP, spune unde se repară", e.message, ["Profil → Email"], []);
  }

  // 8c. Gmail refuză, SMTP neconfigurat → mesajul spune AMBELE motive
  google.cont = () => ({ ok: true });
  gmail.trimite = async () => { throw new Error("unauthorized_client: delegarea lipsește"); };
  try {
    await mail.trimiteDeLa(VALI, { catre: ["x@y.ro"], subiect: "t", corp: "c" });
    rele++; console.log("  PROBLEMĂ Gmail refuză și SMTP lipsește: a zis că a trimis");
  } catch (e) {
    cere("când Gmail refuză, se vede și motivul lui", e.message,
      ["unauthorized_client", "SMTP nu e configurat"], []);
  }

  // 8d. Gmail refuză, SMTP configurat → chiar se încearcă SMTP-ul
  // (portul 1 pe localhost nu ascultă nimeni: dacă apare eroarea de conectare,
  //  înseamnă că s-a ajuns până la el — adică rezerva funcționează)
  const CU_SMTP = Object.assign({}, VALI, { smtp_host: "127.0.0.1", smtp_port: 1, smtp_user: "u", smtp_parola_cifrata: null });
  try {
    await mail.trimiteDeLa(CU_SMTP, { catre: ["x@y.ro"], subiect: "t", corp: "c" });
    rele++; console.log("  PROBLEMĂ SMTP-ul de rezervă: a zis că a trimis către un port mort");
  } catch (e) {
    cere("când Gmail refuză, se încearcă SMTP-ul", e.message, ["127.0.0.1:1"], []);
  }

  google.cont = contReal;
  gmail.trimite = trimiteReal;

  console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
