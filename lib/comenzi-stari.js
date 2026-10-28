"use strict";
// Stările unei comenzi și bara care le arată.
//
// De ce în lib/ și nu în modules/comenzi.js, unde au stat până acum: lista o
// citesc două module. Agentul o vede în CRM (modules/comenzi.js), operatorul
// o vede în lista depozitului (modules/warehouse.js). Până acum depozitul
// scria statusul brut din bază — „in_stoc_depozit", cu underscore — fiindcă
// eticheta frumoasă era închisă în celălalt fișier, iar modules/comenzi.js
// cere deja modules/warehouse.js, deci drumul invers ar fi închis un cerc.
//
// Varianta leneșă ar fi fost să copiez lista în depozit. Două liste care
// trebuie să rămână identice rămân identice exact până la prima modificare
// grăbită. Un fișier în lib/ nu cere nimic înapoi și nu are cum să se
// încurce în importuri.
const { esc } = require("./render");

// Drumul unei comenzi, în ordinea în care se întâmplă de fapt:
// agentul o plasează → depozitul se uită la stoc → ce lipsește se
// aprovizionează sau se produce → marfa ajunge în depozit → abia atunci
// agentul poate cere factura → cineva cu drepturi pe facturare o validează
// și pleacă în SmartBill.
// CULOAREA UNEI COMENZI — UN SINGUR TABEL, PENTRU TOT ERP-UL
//
// Cererea lui Vali, 28.10.2026: „nouă roșu, în producție albastru,
// finalizată verde, livrată sau în livrare negru" și, imediat după,
// „culorile să urmărească comenzile în orice pagină".
//
// A doua propoziție e partea grea, și de-aia tabelul ăsta e aici. Culorile
// erau scrise în două locuri — aici, pentru comenzile de vânzare, și încă o
// dată în modules/productie.js, pentru registrul de producție. Aceeași
// comandă își schimba culoarea când treceai dintr-o pagină în alta, fiindcă
// erau două liste care nu știau una de alta. Acum e una singură, iar
// registrul de producție o citește de aici.
//
// Ce înseamnă fiecare culoare, ca să se poată răspunde la întrebarea „dar
// starea X ce culoare primește?" fără să mai întrebe nimeni:
//
//   roșu    — a venit și nu s-a atins nimeni de ea. Singura stare roșie.
//   albastru— e în lucru la noi.
//   galben  — stă și așteaptă ceva din afara noastră (o validare, marfă).
//   verde   — e gata. Marfa există, comanda și-a făcut treaba.
//   negru   — a plecat la client. Capătul drumului.
//   gri     — ieșită din joc (anulată). Nu mai e o comandă, e o urmă.
//
// „Anulată" era roșie. A trecut pe gri dinadins: dacă roșu înseamnă și
// „nouă", și „anulată", nu mai înseamnă nimic — te uiți peste listă și nu
// mai știi dacă roșul ăla cere ceva de la tine sau e un rând mort.
const CULORI = {
  ciorna: "galben",
  noua: "rosu",
  confirmata: "albastru",
  asteapta_marfa: "galben",
  in_productie: "albastru",
  // „Finalizată" din registrul de producție și „în stoc depozit" din
  // comenzile de vânzare sunt același lucru văzut din două birouri: marfa e
  // gata. Aceeași culoare.
  finalizata: "verde",
  in_stoc_depozit: "verde",
  facturata: "verde",
  livrata: "negru",
  livrata_partial: "negru",
  anulata: "gri",
};

// Culoarea unei stări. Ce nu e în tabel rămâne gri — o stare necunoscută nu
// trebuie să împrumute înțelesul alteia.
function culoare(status) {
  return CULORI[String(status || "")] || "gri";
}

const TEXTE = {
  // „Ciornă" e starea comenzilor citite automat dintr-un email. Nu e în FLUX
  // dinadins: nu se poate factura din ea, nu intră în lista depozitului, și
  // nu pleacă niciun anunț. Există un singur drum înainte — agentul apasă
  // „Validează", iar atunci comanda devine „nouă" și abia atunci se anunță
  // biroul și depozitul. Un robot care citește emailuri n-are voie să pună
  // singur marfă în mișcare.
  ciorna: "ciornă — de validat",
  noua: "nouă",
  confirmata: "confirmată",
  // Depozitul s-a uitat la stoc și n-a avut ce trimite — fie lipsește tot,
  // fie lipsește o parte iar clientul n-a acceptat livrare parțială. Comanda
  // nu e blocată și nu e anulată: stă în lista depozitului și așteaptă
  // aprovizionarea sau producția. Când stocul acoperă tot, trece singură mai
  // departe (vezi modules/warehouse.js).
  asteapta_marfa: "așteaptă marfă",
  in_productie: "în producție",
  in_stoc_depozit: "în stoc depozit",
  facturata: "facturată",
  livrata: "livrată",
  anulata: "anulată",
};

// Eticheta gata desenată. Se naște din cele două tabele de mai sus, nu se
// scrie de mână: altfel culoarea și textul se pot despărți la prima
// modificare, iar asta e exact ce s-a reparat aici.
const STATUS_LABEL = {};
for (const [stare, text] of Object.entries(TEXTE)) {
  STATUS_LABEL[stare] = `<span class="badge ${culoare(stare)}">${text}</span>`;
}

// Ordinea fluxului — folosită ca să știm ce urmează și de la ce pas se poate factura.
const FLUX = ["noua", "confirmata", "asteapta_marfa", "in_productie", "in_stoc_depozit", "facturata", "livrata"];

// De la starea asta încolo agentul poate apăsa „Facturează".
const STARE_FACTURABILA = "in_stoc_depozit";

const PASI_ETICHETE = {
  noua: "nouă",
  confirmata: "confirmată",
  asteapta_marfa: "așteaptă marfă",
  in_productie: "în producție",
  in_stoc_depozit: "în stoc depozit",
  facturata: "facturată",
  livrata: "livrată",
};

// Stări care EXISTĂ în ERP, dar nu pe drumul unei comenzi de vânzare.
// „Finalizată" e a registrului de producție, iar „livrată parțial" apare din
// livrările pe bucăți. NU intră în TEXTE, fiindcă din TEXTE se naște lista
// de stări pe care o poate alege adminul pe o comandă de vânzare — le-ar
// pune în acel select stări care n-au ce căuta acolo. Dar dacă vreo pagină
// ajunge totuși să le afișeze, trebuie să arate ca niște stări, nu ca un
// nume de coloană din bază.
const TEXTE_ALTE = {
  finalizata: "finalizată",
  livrata_partial: "livrată parțial",
};

function eticheta(status) {
  const s = String(status || "");
  if (STATUS_LABEL[s]) return STATUS_LABEL[s];
  // Are culoare în tabel, dar nu e o stare de vânzări: o desenăm oricum, cu
  // culoarea ei. Înainte ieșea textul brut, „livrata_partial", fără insignă.
  if (CULORI[s]) return `<span class="badge ${culoare(s)}">${esc(TEXTE_ALTE[s] || s.replace(/_/g, " "))}</span>`;
  return esc(s || "—");
}

// Cine mută ce — fiecare pe bucata lui de drum.
//
// Până acum ruta de status accepta admin, depozit și financiar. Comentariul
// de deasupra ei spunea „doar producția, depozitul, financiarul sau adminul",
// deci producția era intenționată și pur și simplu lipsea din listă: omul
// care chiar face marfa nu-și putea trece comanda pe „în producție".
//
// Agentul nu apare cu stările de livrare, și nu din neîncredere: el nu vede
// când pleacă marfa din depozit, deci n-are de unde să știe. Își poate anula
// comanda lui, fiindcă el a vorbit cu clientul care s-a răzgândit — pe a
// altuia, nu. Factura o cere tot el, dar prin butonul „Facturează", care
// naște o ciornă ce trece pe la facturare, nu prin mutarea statusului.
const STARI_PE_ROL = {
  depozit: ["confirmata", "asteapta_marfa", "in_stoc_depozit", "livrata", "anulata"],
  productie: ["in_productie", "in_stoc_depozit"],
  financiar: ["facturata", "livrata", "anulata"],
  vanzari: ["anulata"],
};

// Stările pe care omul ăsta le poate pune pe comanda asta, în ordinea
// fluxului. Lista goală înseamnă „n-are ce muta aici", și atunci pagina nu
// mai arată deloc formularul de status.
function stariPermise(user, comanda) {
  if (!user) return [];
  if (user.rol === "admin") return Object.keys(STATUS_LABEL).filter((s) => s !== "ciorna");
  const lista = STARI_PE_ROL[user.rol] || [];
  // Agentul doar pe comanda lui.
  if (user.rol === "vanzari" && comanda && Number(comanda.agent_id) !== Number(user.id)) return [];
  const rang = (s) => {
    const i = FLUX.indexOf(s);
    return i === -1 ? FLUX.length : i;
  };
  return [...lista].sort((a, b) => rang(a) - rang(b));
}

function poateMuta(user, comanda, status) {
  return stariPermise(user, comanda).includes(String(status || ""));
}

function poateFactura(comanda) {
  const i = FLUX.indexOf(comanda && comanda.status);
  return i >= FLUX.indexOf(STARE_FACTURABILA) && comanda && comanda.status !== "anulata";
}

// Bara de status: unde e comanda acum, pe tot drumul ei.
//
// Cererea lui Vali a fost „apare status la orice pas". Statusul exista deja
// ca text într-o casetă, dar un cuvânt singur nu spune nici cât a trecut,
// nici cât a mai rămas. Bara arată tot drumul, cu pașii făcuți bifați și cel
// de acum aprins.
//
// „Așteaptă marfă" se arată doar dacă acolo e comanda chiar acum: e o
// ocolire, nu un pas obligatoriu, și n-are rost să apară pe comenzile care
// au găsit marfa din prima.
function bara(comanda) {
  const stare = String((comanda && comanda.status) || "");
  if (stare === "ciorna") {
    return '<p class="mic" style="color:var(--text-muted);margin:0 0 12px">Ciornă — drumul comenzii începe după ce o validezi.</p>';
  }
  if (stare === "anulata") {
    const motiv = comanda && comanda.motiv_anulare ? " — " + esc(comanda.motiv_anulare) : "";
    return `<p style="margin:0 0 12px">${STATUS_LABEL.anulata}${motiv}</p>`;
  }
  const pasi = FLUX.filter((p) => p !== "asteapta_marfa" || stare === "asteapta_marfa");
  const acum = pasi.indexOf(stare);
  const celule = pasi
    .map((p, i) => {
      const facut = acum >= 0 && i < acum;
      const curent = i === acum;
      const fundal = curent ? "var(--accent-slab,#e8f0fe)" : "transparent";
      const bordura = curent ? "1px solid var(--accent,#2f5d9c)" : "1px solid var(--border,#ddd)";
      const culoare = curent ? "var(--text)" : "var(--text-muted)";
      const greutate = curent ? "600" : "400";
      const semn = facut ? "✓ " : "";
      return (
        `<li style="padding:4px 10px;border:${bordura};border-radius:999px;background:${fundal};` +
        `color:${culoare};font-weight:${greutate};font-size:12px;white-space:nowrap">${semn}${esc(PASI_ETICHETE[p] || p)}</li>`
      );
    })
    .join("");
  return `<ol style="display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:0 0 12px">${celule}</ol>`;
}

module.exports = {
  STATUS_LABEL, FLUX, STARE_FACTURABILA, PASI_ETICHETE, STARI_PE_ROL,
  // CULORI și culoare() sunt exportate ca registrul de producție să nu-și
  // mai țină lista lui. O comandă trebuie să aibă aceeași culoare în orice
  // pagină o vezi.
  CULORI, culoare, TEXTE,
  eticheta, poateFactura, bara, stariPermise, poateMuta,
};
