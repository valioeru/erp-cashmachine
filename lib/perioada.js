"use strict";
// Perioada, o singura data pentru toata aplicatia.
//
// Peste tot unde se filtreaza dupa data se ofera aceleasi patru presetari —
// luna curenta, luna trecuta, anul curent, anul trecut — plus „tot" si un
// interval la alegere. Pana acum fiecare pagina isi facea filtrul ei: unele
// aveau zece optiuni, altele niciuna, si nu se comportau la fel. De-aia sta
// aici: se schimba intr-un loc si se vede peste tot.
//
// Cheia din adresa e „perioada". Intervalul propriu vine in „de_la" si
// „pana_la", tot in aaaa-ll-zz — asa cere <input type="date">, iar afisarea
// zz.ll.aaaa o face stratul de randare, nu paginile.

const { esc } = require("./render");

const PRESETARI = [
  ["luna_curenta", "luna curentă"],
  ["luna_trecuta", "luna trecută"],
  ["an_curent", "anul curent"],
  ["an_trecut", "anul trecut"],
];

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function ultimaZi(an, luna) {
  return `${an}-${String(luna).padStart(2, "0")}-${String(new Date(Date.UTC(an, luna, 0)).getUTCDate()).padStart(2, "0")}`;
}

function eData(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}

// Lunile acoperite de interval, „aaaa-ll" — costurile si salariile sunt lunare.
function luniIntre(de, la) {
  const rez = [];
  let a = Number(de.slice(0, 4));
  let m = Number(de.slice(5, 7));
  const capat = la.slice(0, 7);
  while (`${a}-${String(m).padStart(2, "0")}` <= capat && rez.length < 360) {
    rez.push(`${a}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      a++;
    }
  }
  return rez;
}

// „implicit" spune ce presetare se ia cand adresa n-are niciuna. Scadentarul
// vrea altceva decat facturile, de-aia e parametru si nu o constanta.
function perioadaDin(query, implicit) {
  const q = query || {};
  const aziStr = azi();
  const an = Number(aziStr.slice(0, 4));
  const luna = Number(aziStr.slice(5, 7));
  let cheie = String(q.perioada || implicit || "luna_curenta");
  let de;
  let la = aziStr;
  let eticheta;

  if (cheie === "luna_trecuta") {
    const a = luna === 1 ? an - 1 : an;
    const l = luna === 1 ? 12 : luna - 1;
    de = `${a}-${String(l).padStart(2, "0")}-01`;
    la = ultimaZi(a, l);
    eticheta = "luna trecută";
  } else if (cheie === "an_curent") {
    de = `${an}-01-01`;
    la = `${an}-12-31`;
    eticheta = `anul ${an}`;
  } else if (cheie === "an_trecut") {
    de = `${an - 1}-01-01`;
    la = `${an - 1}-12-31`;
    eticheta = `anul ${an - 1}`;
  } else if (cheie === "tot") {
    de = "2000-01-01";
    la = `${an + 1}-12-31`;
    eticheta = "tot istoricul";
  } else if (cheie === "custom") {
    de = eData(q.de_la) ? String(q.de_la) : `${an}-01-01`;
    la = eData(q.pana_la) ? String(q.pana_la) : aziStr;
    if (la < de) {
      const t = de;
      de = la;
      la = t;
    }
    eticheta = `${de} → ${la}`;
  } else if (/^\d{4}-\d{2}$/.test(cheie)) {
    de = `${cheie}-01`;
    la = ultimaZi(Number(cheie.slice(0, 4)), Number(cheie.slice(5, 7)));
    eticheta = cheie;
  } else {
    cheie = "luna_curenta";
    de = `${aziStr.slice(0, 7)}-01`;
    la = ultimaZi(an, luna);
    eticheta = "luna curentă";
  }

  return { cheie, de, la, eticheta, luni: luniIntre(de, la), azi: aziStr };
}

// Presetarile ca butoane de trimitere, pentru paginile care AU deja un
// formular de filtre: butonul isi trimite singur valoarea, deci restul
// campurilor formularului (cautare, status, agent) se pastreaza de la sine.
function chipuriPerioada(cheie, opt) {
  const o = opt || {};
  const lista = PRESETARI.concat(o.faraTot ? [] : [["tot", "tot"]]);
  return lista
    .map(
      (x) =>
        `<button type="submit" name="perioada" value="${x[0]}" class="chip${cheie === x[0] ? " activ" : ""}">${esc(x[1])}</button>`
    )
    .join("");
}

module.exports = { PRESETARI, perioadaDin, chipuriPerioada, luniIntre, ultimaZi, azi };
