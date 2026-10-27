"use strict";
// Ce s-a schimbat pe o comandă: comparația dintre cum era și cum a rămas.
//
// Stă separat de ecran și de bază fiindcă ASTA e partea care trebuie să fie
// corectă. Dacă ecranul pierde un câmp, se vede. Dacă istoricul pierde o
// schimbare, nu se vede niciodată — iar peste trei luni, când clientul spune
// „eu am comandat 20.000, nu 25.000”, nu mai are cine să răspundă.
//
// Fără bază de date, ca să poată fi verificat de test.

// Cum arată o valoare în istoric. Nu „null”, nu „undefined”, nu „[object
// Object]” — astea sunt cuvintele programatorului, iar istoricul îl citește
// omul de la vânzări.
function text(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

// Două valori sunt „la fel” dacă arată la fel după curățare.
//
// Numerele se compară ca numere, nu ca text: „25000” venit din formular și
// 25000 citit din bază sunt același lucru, iar dacă le-am compara ca text
// fiecare salvare ar scrie în istoric o schimbare care nu s-a întâmplat.
// Istoricul plin de zgomot nu se mai citește, deci nu mai apără nimic.
function lafel(a, b) {
  const ta = text(a);
  const tb = text(b);
  if (ta === tb) return true;
  const na = Number(String(ta).replace(",", "."));
  const nb = Number(String(tb).replace(",", "."));
  if (ta !== "" && tb !== "" && isFinite(na) && isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  return false;
}

// Schimbările de pe capul comenzii.
//
// `etichete` spune cum se cheamă fiecare câmp pentru om: { numar: "Număr
// comandă", ... }. Un câmp fără etichetă nu se compară deloc — așa, o coloană
// tehnică adăugată mâine în tabel (`verificata_depozit_la`) nu ajunge în
// istoricul pe care-l citește agentul.
function diferente(vechi, nou, etichete) {
  const out = [];
  for (const camp of Object.keys(etichete || {})) {
    if (!(camp in (nou || {}))) continue;
    if (lafel(vechi ? vechi[camp] : undefined, nou[camp])) continue;
    out.push({ ce: etichete[camp], vechi: text(vechi ? vechi[camp] : ""), nou: text(nou[camp]) });
  }
  return out;
}

// Schimbările de pe liniile comenzii.
//
// Liniile n-au cum fi comparate „una câte una în ordine”: omul șterge a doua
// linie și adaugă alta la coadă, iar o comparație pe poziții ar scrie trei
// schimbări acolo unde s-a întâmplat una. Se compară pe PRODUS, fiindcă ăsta
// e lucrul care identifică linia pentru cine citește.
//
// Două linii cu același produs pe aceeași comandă sunt o greșeală de
// introdus, dar se întâmplă: le adunăm, ca să nu se piardă una din ele.
function liniiPeProdus(linii) {
  const m = new Map();
  for (const l of linii || []) {
    const id = Number(l.produs_id);
    if (!id) continue;
    const got = m.get(id);
    if (!got) {
      m.set(id, {
        produs_id: id,
        denumire: text(l.denumire) || ("produs #" + id),
        cantitate: Number(l.cantitate || 0),
        pret_unitar: Number(l.pret_unitar || 0),
        um: text(l.um),
      });
    } else {
      got.cantitate += Number(l.cantitate || 0);
    }
  }
  return m;
}

function cant(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
function bani(v) {
  return Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diferenteLinii(vechi, nou) {
  const a = liniiPeProdus(vechi);
  const b = liniiPeProdus(nou);
  const out = [];

  for (const [id, l] of b) {
    const v = a.get(id);
    if (!v) {
      out.push({
        ce: "Linie adăugată · " + l.denumire,
        vechi: "",
        nou: cant(l.cantitate) + (l.um ? " " + l.um : "") + " × " + bani(l.pret_unitar),
      });
      continue;
    }
    if (!lafel(v.cantitate, l.cantitate)) {
      out.push({ ce: "Cantitate · " + l.denumire, vechi: cant(v.cantitate), nou: cant(l.cantitate) });
    }
    if (!lafel(v.pret_unitar, l.pret_unitar)) {
      out.push({ ce: "Preț · " + l.denumire, vechi: bani(v.pret_unitar), nou: bani(l.pret_unitar) });
    }
    if (!lafel(v.um, l.um)) {
      out.push({ ce: "Unitate · " + l.denumire, vechi: v.um, nou: l.um });
    }
  }

  for (const [id, l] of a) {
    if (b.has(id)) continue;
    out.push({
      ce: "Linie ștearsă · " + l.denumire,
      vechi: cant(l.cantitate) + (l.um ? " " + l.um : "") + " × " + bani(l.pret_unitar),
      nou: "",
    });
  }
  return out;
}

// Etichetele câmpurilor de pe capul comenzii. Scrise o dată, aici: dacă
// fiecare ecran și-ar scrie propriile nume, același câmp ar apărea în istoric
// cu două denumiri și ar părea că sunt două lucruri diferite.
const ETICHETE = {
  partener_id: "Client",
  numar: "Număr comandă",
  data_livrare_ceruta: "Termen cerut de client",
  livrare_partiala: "Livrare parțială",
  moneda: "Moneda",
  observatii: "Observații",
};

// Cine are voie să schimbe comanda.
//
// Cererea lui Vali, 27.10.2026: „ownerul de client” — adică agentul pe al
// cărui nume stă firma — poate modifica ORICE comandă a clientului lui, nu
// doar pe cele plasate chiar de el. Până acum o comandă luată de un coleg nu
// se putea atinge, iar corectura se făcea pe telefon.
//
// Administratorul poate oricum. Agentul care a plasat comanda rămâne și el,
// chiar dacă între timp clientul a trecut la alt coleg: el a scris-o, el știe
// ce-a vorbit.
function poateEdita(user, comanda, partener) {
  if (!user) return false;
  if (user.rol === "admin") return true;
  const eu = Number(user.id);
  if (comanda && Number(comanda.agent_id) === eu) return true;
  if (partener && Number(partener.agent_id) === eu) return true;
  return false;
}

// De ce ar trebui să se uite de două ori înainte să salveze.
//
// Nu oprește pe nimeni — Vali a cerut „orice comandă”. Dar o comandă deja
// facturată, livrată sau anulată are urmări în afara ERP-ului, iar omul
// trebuie să le vadă ÎNAINTE, nu să le descopere la inventar.
function avertismente(comanda) {
  const out = [];
  if (!comanda) return out;
  if (comanda.factura_id) {
    out.push(
      "Comanda are deja factură. Dacă schimbi cantitățile sau prețurile, factura rămâne cum e — " +
        "nu se rescrie singură, și de acum încolo cele două nu mai spun același lucru."
    );
  }
  if (comanda.status === "anulata") {
    out.push("Comanda e anulată. O modificare acum nu o reînvie — rămâne anulată, doar cu alte cifre pe ea.");
  }
  if (comanda.status === "livrata" || comanda.status === "livrata_partial") {
    out.push("Din comandă a plecat deja marfă. Ce schimbi aici nu schimbă ce-a ieșit din depozit.");
  }
  return out;
}

module.exports = { diferente, diferenteLinii, ETICHETE, poateEdita, avertismente, lafel, text };
