"use strict";
// Mailul de cerere de comision trebuie să plece pe primul drum care merge.
//
// De ce există testul: pe 30.09.2026 Cătălin Georgescu a cerut 2.500 lei și
// mailul n-a plecat — „535-5.7.8 Username and Password not accepted", adică
// parola de aplicație Google de pe fișa unui om expirase. Codul lua primul
// utilizator cu SMTP pus pe fișă (`if (cfg) break`) și se oprea acolo: dacă
// ăla nu mergea, gata. Deși ERP-ul are un service account Google care poate
// trimite fără nicio parolă, și deși alți oameni aveau SMTP valid.
//
// Ce se verifică, fără să plece vreun email pe bune (Gmail și SMTP sunt
// înlocuite cu funcții de probă):
//   1. când Gmail merge, mailul pleacă prin Gmail, fără parolă;
//   2. când Gmail pică, se trece pe SMTP-ul aceluiași om;
//   3. când și SMTP-ul lui pică, se trece la următorul candidat;
//   4. când nu merge nimic, eroarea le spune pe toate;
//   5. ordinea candidaților: agentul, apoi adminii, apoi restul;
//   6. cererea rămâne înregistrată chiar dacă mailul nu pleacă.
//
// Se rulează din rădăcina repo-ului. Nu are nevoie de bază de date.
const path = require("path");
const Module = require("module");

const RAD = __dirname;
let picate = 0;
function bine(nume, conditie, detaliu) {
  if (conditie) console.log(`  ok   ${nume}`);
  else { picate++; console.log(`  PICAT ${nume}${detaliu !== undefined ? ": " + detaliu : ""}`); }
}

// Nu deschidem niciun socket și nu punem nicio parolă adevărată nicăieri:
// îi dăm lui trimitePrinOricare alte „căi" de trimitere, care doar notează
// ce s-a cerut și reușesc sau pică după scenariul jucat.
const mail = require(path.join(RAD, "lib", "mail.js"));

const stub = { googleOk: true, gmailMerge: true, smtpCareMerg: new Set(), gmail: [], smtp: [] };
const CAI = {
  areGoogle: () => stub.googleOk,
  gmail: async (adresa, mesaj) => {
    if (!stub.gmailMerge) throw new Error("Delegation denied for " + adresa);
    stub.gmail.push({ adresa, subiect: mesaj.subiect });
  },
  smtp: async (cfg, mesaj) => {
    if (!stub.smtpCareMerg.has(cfg.user)) {
      throw new Error('Serverul de email a refuzat pasul „autentificare": 535-5.7.8 Username and Password not accepted');
    }
    stub.smtp.push({ user: cfg.user, subiect: mesaj.subiect });
  },
};

// Un utilizator cu SMTP pe fișă. Parola trece prin chiar funcția de cifrare a
// modulului, cu o valoare de probă — nu ținem parole reale în teste.
const cu = (id, nume, email, areSmtp) => ({
  id, nume, email, email_expeditor: email,
  smtp_host: areSmtp ? "smtp.gmail.com" : null,
  smtp_port: 587,
  smtp_user: email,
  smtp_parola_cifrata: areSmtp ? mail.cifreaza("valoare-de-proba") : null,
  smtp_securizare: "starttls",
});

const MESAJ = { catre: ["valentin.oeru@cashmachine.ro"], subiect: "Cerere comision", corp: "test" };
const resetStub = () => { stub.gmail = []; stub.smtp = []; };

(async () => {
  console.log("Mailul de cerere pleacă pe primul drum care merge\n");

  const catalin = cu(4, "Cătălin Georgescu", "catalin.georgescu@cashmachine.ro", true);
  const vali = cu(1, "Valentin Oeru", "valentin.oeru@cashmachine.ro", true);

  // ---- 1. Gmail merge --------------------------------------------------
  console.log("când Gmail merge:");
  resetStub(); stub.googleOk = true; stub.gmailMerge = true; stub.smtpCareMerg = new Set();
  let r = await mail.trimitePrinOricare([catalin, vali], MESAJ, CAI);
  bine("pleacă prin Gmail, fără nicio parolă", r.prin === "Gmail", JSON.stringify(r));
  bine("de pe adresa agentului care cere", r.expeditor === catalin.email, r.expeditor);
  bine("nu s-a atins de SMTP", stub.smtp.length === 0);

  // ---- 2. Gmail pică, SMTP-ul lui merge --------------------------------
  console.log("\ncând Gmail pică, dar SMTP-ul lui merge:");
  resetStub(); stub.gmailMerge = false; stub.smtpCareMerg = new Set([catalin.email]);
  r = await mail.trimitePrinOricare([catalin, vali], MESAJ, CAI);
  bine("pleacă prin SMTP", r.prin === "SMTP", JSON.stringify(r));
  bine("tot de pe adresa agentului", r.expeditor === catalin.email, r.expeditor);
  bine("spune ce a picat pe drum", r.incercari.length === 1 && /Gmail/.test(r.incercari[0]), JSON.stringify(r.incercari));

  // ---- 3. amândouă ale lui pică, trece la următorul --------------------
  // Ăsta e chiar bug-ul din 30.09: înainte se oprea aici.
  console.log("\ncând și Gmail, și SMTP-ul lui pică:");
  resetStub(); stub.gmailMerge = false; stub.smtpCareMerg = new Set([vali.email]);
  r = await mail.trimitePrinOricare([catalin, vali], MESAJ, CAI);
  bine("NU se oprește la primul candidat", r.prin === "SMTP", JSON.stringify(r));
  bine("pleacă de pe al doilea", r.expeditor === vali.email, r.expeditor);
  bine("a încercat de patru ori înainte", r.incercari.length === 3, JSON.stringify(r.incercari));
  bine("una din încercări arată eroarea 535",
    r.incercari.some((x) => /535-5\.7\.8/.test(x)), JSON.stringify(r.incercari));

  // ---- 4. nu merge nimic -----------------------------------------------
  console.log("\ncând nu merge niciun drum:");
  resetStub(); stub.gmailMerge = false; stub.smtpCareMerg = new Set();
  let eroare = null;
  try { await mail.trimitePrinOricare([catalin, vali], MESAJ, CAI); }
  catch (e) { eroare = e; }
  bine("dă eroare, nu se preface că a trimis", !!eroare);
  bine("eroarea le enumeră pe toate", eroare && eroare.incercari && eroare.incercari.length === 4,
    eroare && JSON.stringify(eroare.incercari));
  bine("eroarea pomenește parola refuzată", eroare && /Username and Password not accepted/.test(eroare.message));

  // ---- 5. fără Google deloc --------------------------------------------
  console.log("\ncând service account-ul Google nu e configurat:");
  resetStub(); stub.googleOk = false; stub.smtpCareMerg = new Set([vali.email]);
  r = await mail.trimitePrinOricare([catalin, vali], MESAJ, CAI);
  bine("nu încearcă Gmail degeaba", !r.incercari.some((x) => /^Gmail/.test(x)), JSON.stringify(r.incercari));
  bine("merge direct pe SMTP-ul care funcționează", r.prin === "SMTP" && r.expeditor === vali.email, JSON.stringify(r));

  // un om fără nimic configurat e sărit, nu crapă
  resetStub(); stub.googleOk = false; stub.smtpCareMerg = new Set([vali.email]);
  const golas = cu(9, "Fără email", "", false);
  r = await mail.trimitePrinOricare([golas, vali], MESAJ, CAI);
  bine("un om fără email configurat e sărit, nu oprește lanțul", r.prin === "SMTP", JSON.stringify(r));

  // ---- 6. ruta chiar folosește lanțul ----------------------------------
  console.log("\nruta de cerere folosește lanțul, nu primul SMTP:");
  const fs = require("fs");
  const sursa = fs.readFileSync(path.join(RAD, "modules", "comision.js"), "utf8");
  bine("cheamă trimitePrinOricare", /mail\.trimitePrinOricare\(candidati/.test(sursa));
  bine("nu mai ia primul SMTP și atât", !/if \(cfg\) \{ exp = cfg; break; \}/.test(sursa));
  bine("agentul e primul candidat, adminii după",
    /ORDER BY CASE WHEN id = \? THEN 0 WHEN rol = 'admin' THEN 1 ELSE 2 END/.test(sursa));
  bine("scrie în bază pe unde a plecat", /trimis prin \$\{dus\.prin\}/.test(sursa));
  bine("cererea rămâne înregistrată chiar dacă mailul pică",
    /cererea e înregistrată/.test(sursa) && /UPDATE cereri_comision SET email_stare/.test(sursa));
  bine("mesajul îi spune omului unde se repară", /Profil → Email/.test(sursa));

  console.log(picate ? `\n${picate} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(picate ? 1 : 0);
})().catch((e) => {
  console.error("Testul a crăpat:", e.message);
  process.exit(2);
});
