"use strict";
// Service worker-ul ERP-ului. Face UN singur lucru: ține în buzunar fișierele
// care nu se schimbă (css, iconițe), ca aplicația să pornească instant de pe
// ecranul telefonului.
//
// CE NU FACE, ȘI DE CE:
//
//   NU ȚINE NICIO PAGINĂ. Niciun HTML, niciun răspuns de la server. Un ERP
//   arată bani, stocuri și comenzi — o pagină ținută în buzunar ar arăta
//   soldul de acum două zile, cu cifre care par bune. E cel mai urât fel de
//   greșeală: tăcută, și cu aer de adevăr. Deci orice pagină se cere de la
//   server, de fiecare dată. Dacă nu e semnal, se vede limpede că nu e semnal.
//
//   NU ȚINE NIMIC DE LA ALT SERVER și nu se atinge de nimic care nu e GET —
//   o comandă trimisă nu are ce căuta într-un buzunar.
//
// Când se schimbă style.css: se ridică VERSIUNEA de mai jos. Altfel telefoanele
// care au deja aplicația rămân cu foaia de stil veche până curăță cineva
// datele site-ului — și nimeni nu face asta.
const VERSIUNE = "erp-v2";

// Doar lucruri care nu se schimbă de la o oră la alta.
const STATICE = ["/style.css", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon-32.png"];

// Pagina arătată când nu e semnal. Stă scrisă aici, nu luată de pe server:
// tocmai serverul e cel care nu răspunde în clipa aia.
const FARA_SEMNAL = `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fără legătură · ERP Cash Machine</title>
<style>
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:#f5f6f8; color:#1c2230; }
  main { max-width:420px; margin:0 auto; padding:72px 20px; text-align:center; }
  h1 { font-size:20px; margin:0 0 10px }
  p { color:#667085; line-height:1.5; margin:0 0 20px }
  button { font:inherit; font-weight:600; padding:12px 20px; min-height:44px; border:0; border-radius:8px;
           background:#2f5d9c; color:#fff; cursor:pointer; }
</style></head><body><main>
<h1>Nu am legătură cu ERP-ul</h1>
<p>Telefonul nu ajunge acum la server. Datele nu se țin pe telefon — tocmai ca să nu vezi cifre vechi
crezând că sunt de azi. Încearcă din nou când ai semnal.</p>
<button onclick="location.reload()">Încearcă din nou</button>
</main></body></html>`;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSIUNE)
      // addAll pică de tot dacă UN fișier lipsește, și atunci service
      // worker-ul nu se instalează deloc. Le punem pe rând: o iconiță lipsă
      // nu are voie să lase aplicația neinstalabilă.
      .then((c) => Promise.all(STATICE.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((chei) => Promise.all(chei.filter((k) => k !== VERSIUNE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const cerere = e.request;
  if (cerere.method !== "GET") return;

  let adresa;
  try {
    adresa = new URL(cerere.url);
  } catch (err) {
    return;
  }
  if (adresa.origin !== self.location.origin) return;

  // Fișierele statice: din buzunar dacă sunt, altfel de pe server (și atunci
  // se pun deoparte pentru data viitoare).
  if (STATICE.indexOf(adresa.pathname) !== -1) {
    e.respondWith(
      caches.match(adresa.pathname).then(
        (gasit) =>
          gasit ||
          fetch(cerere).then((r) => {
            if (r && r.ok) {
              const copie = r.clone();
              caches.open(VERSIUNE).then((c) => c.put(adresa.pathname, copie));
            }
            return r;
          })
      )
    );
    return;
  }

  // Orice altceva — adică tot ce are date în el — merge la server, mereu.
  // Dacă nu se poate, și e o pagină întreagă, arătăm că nu e semnal. Pentru o
  // cerere de fundal (fetch din pagină) lăsăm eroarea să ajungă la cod, ca
  // pagina să-și spună singură ce are de spus.
  if (cerere.mode === "navigate") {
    e.respondWith(
      fetch(cerere).catch(
        () => new Response(FARA_SEMNAL, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })
      )
    );
  }
});
