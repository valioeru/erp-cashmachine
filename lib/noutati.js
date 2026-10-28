"use strict";
// Ce s-a adăugat în ERP, în ordine. Cel mai nou sus.
//
// CEREREA LUI VALI, 27.10.2026: „o pagină unde să scrii tot ce a mai fost
// adăugat nou în ERP, ultimele 30 de update-uri și/sau dezvoltări, mereu.”
//
// DE CE E UN FIȘIER, NU UN TABEL ÎN BAZĂ:
//
//   Rândurile de aici descriu CODUL. Dacă ar sta în bază, s-ar putea
//   dezlipi de el: o dezvoltare oprită înainte de deploy ar rămâne scrisă ca
//   făcută, iar una urcată în grabă n-ar apărea deloc. Așa, textul urcă odată
//   cu modificarea pe care o descrie — sau nu urcă niciuna.
//
//   Al doilea motiv: nimeni n-are de completat un formular. Pagina se
//   actualizează de la sine, din ce se urcă.
//
// CUM SE SCRIE UN RÂND:
//
//   [data, titlu, ce s-a schimbat de fapt, unde se vede în ERP]
//
//   Titlul spune lucrul, nu fișierul. „Codul produsului se scrie singur”, nu
//   „refactor lib/cod-produs”. Textul spune ce poate omul face acum și n-a
//   putut înainte — pagina asta o citește cineva care n-a scris codul.
//   Ultimul câmp e adresa din ERP, sau gol dacă n-are una.

const LISTA = [
  ["2026-10-27", "Fișierul de planificare lunară stă în ERP, cu versiuni",
   "Pe pagina de planificare, sus, e zona unde se urcă foaia lunii — .xlsx, .xls, .csv, .ods sau .pdf. Fiecare urcare e o versiune nouă, nu o înlocuire: cea de sus e cea validă, iar cele de dedesubt rămân, ca să se poată vedea ce scria în plan la începutul lunii și cine a schimbat ce. Se poate scrie și o notă („ce s-a schimbat”). Fișierul pleacă în Drive, într-un folder pe lună; dacă Drive nu răspunde, rămâne în ERP și pagina spune asta pe față, ca nimeni să nu creadă că e în Drive când nu e. Lunile trecute stau strânse, ca să nu crească pagina la nesfârșit. Gridurile de utilaje și oameni nu se schimbă — ele se fac tot din alocări, nu din fișier.",
   "/productie/planificare"],

  ["2026-10-27", "Patru facturi dublate de sincronizare, scoase — și cauza reparată",
   "CSHM3322, 3323, 3324 și 3325, toate din 20.10, intraseră de două ori: 81.757,76 lei de vânzări care nu existau. Cauza: sincronizarea citea firma emitentă cu o căutare peste tot textul paginii SmartBill, iar acolo, printre clienți, stă și „WAREHOUSE ALL SRL”, firmă din grup. Când potrivirea aia venea prima, lotul pleca etichetat cu firma greșită — iar cheia care recunoaște o factură deja intrată are firma în ea, deci nu se mai recunoștea nimic. Acum firma se citește din antetul SmartBill, nu din tabel; numele se potrivește indiferent cum e scrisă forma juridică („CASH MACHINE S.R.L.” = „Cash Machine SRL”); iar în ERP o factură cu aceeași serie și același număr nu se mai scrie a doua oară, oricare ar fi firma din lot. Exemplarele în plus au ieșit din calcule, nu s-au șters — se pot readuce din Verificări date.",
   "/admin/date"],

  ["2026-10-27", "Clientul nou se scrie direct din comandă, pe numele agentului",
   "Dacă firma nu e în bază, în lista de căutare apare „+ Client nou” și se deschide un formular acolo: denumire și CUI obligatorii, plus telefon, email, persoană de contact și adresă. Clientul intră pe numele agentului care îl scrie, deci apare imediat în lista lui. CUI-ul se verifică pe cifra de control — o cifră tastată strâmb face o firmă care arată ca una adevărată, și se descoperă abia la facturare. Codurile din alte țări (HU, DE) se acceptă fără verificarea noastră. Înainte de a scrie, caută dubluri după CUI și după nume curățat de forme juridice: „S.C. Sameday S.R.L.” o găsește pe „Sameday Courier SRL” în loc să facă a doua fișă. Un furnizor care începe să cumpere devine „ambele”, nu al doilea rând.",
   "/comenzi/nou"],

  ["2026-10-27", "Comanda salvată spune că s-a salvat",
   "Sus pe pagina comenzii apare confirmarea: numărul, clientul, câte linii și totalul. La modificare scrie câte schimbări au intrat în istoric, iar dacă n-ai schimbat nimic îți spune asta — până acum pagina se schimba și atât, iar omul rămânea cu întrebarea dacă a intrat sau nu.",
   "/comenzi/nou"],

  ["2026-10-27", "O caracteristică de cod se poate modifica, nu doar adăuga și șterge",
   "Buton „Modifică” pe fiecare rând din configurarea codului: denumire, ordine, unitate, câte cifre intră în cod, minim, maxim, dacă intră în cod, dacă e obligatorie, dacă e activă. Până acum, ca să scoți ceva din cod trebuia șters și rescris — iar dacă apucase să nască produse, ștergerea doar îl dezactiva și nu se mai putea repara deloc. Felul (listă sau număr) și familia NU se schimbă: o listă trecută pe număr și-ar lăsa valorile orfane, iar codul ar înceta să iasă fără ca nimeni să înțeleagă de ce.",
   "/configurari/cod-produs"],

  ["2026-10-27", "Folia stretch are acum Virgin / Reciclat, în cod",
   "Litera intră imediat după tip, ca la folia debitată: FSV… pentru virgin, FSR… pentru reciclat. Erau două produse diferite, cu costuri diferite, care până acum nu se puteau deosebi — ar fi stat pe aceeași linie de stoc. Produsele deja scrise își păstrează codul; doar cele noi ies cu litera în plus.",
   "/configurari/cod-produs"],

  ["2026-10-27", "O ofertă de furnizor deja salvată se poate modifica",
   "Buton „Modifică” pe fiecare ofertă din istoricul articolului: preț, furnizor, monedă, cantitate minimă, condiții, termene. Până acum un preț tastat greșit se putea doar scoate și rescris, iar istoricul rămânea cu o gaură și cu o ofertă „scoasă” pe care nimeni nu mai știa de ce. Articolul NU se schimbă de aici — o ofertă mutată ar scoate un preț dintr-un istoric și ar pune în altul unul care n-a existat.",
   "/procurement"],

  ["2026-10-27", "Folie stretch: greutatea și lungimea se calculează una din alta",
   "La configurarea unei folii stretch apare o căsuță de greutate. Scrii kilogramele și îți iese lungimea; scrii lungimea și îți iese greutatea. Lățimea e 50 cm, densitatea 0,918 g/cm³ — adică 0,000459 kg pe fiecare metru și micron. Verificat pe role reale: 23µ × 300 m dau 3,17 kg, iar 17µ × 1500 m dau 11,7 kg. Căsuța apare DOAR la familiile cu lățime fixă; la bandă adezivă, care își alege lățimea, formula ar fi ieșit de zece ori pe lângă, deci nu apare.",
   "/comenzi/nou"],

  ["2026-10-27", "Valorile unei liste se scriu toate deodată",
   "La configurarea produsului spui câte valori are lista și le completezi pe toate într-un singur formular. Până acum se adăuga una câte una, cu o reîncărcare de pagină între ele. Două valori cu aceeași bucată de cod sunt refuzate și scrise pe ecran: ar fi însemnat două produse diferite cu același cod.",
   "/configurari/cod-produs"],

  ["2026-10-27", "Registrul de producție arată pe ce mașină merge comanda",
   "Coloană nouă, „Utilaj”, lângă stare. Apare DOAR după ce comanda a fost pusă pe „în producție” — până atunci o alocare e o intenție, nu un fapt, și se mai schimbă de două ori până pornește lotul. O comandă în producție care n-are încă nicio alocare scrie „nealocată” pe galben, ca s-o vadă cineva dimineața.",
   "/productie"],

  ["2026-10-27", "Comenzile în euro se socotesc la cursul BNR, iar prețul ține patru zecimale",
   "ERP-ul ia singur cursul oficial de pe site-ul BNR și îl ține pe zile. O comandă în euro primește cursul zilei în care a fost scrisă, ÎNGHEȚAT pe ea — altfel suma în lei s-ar schimba singură în fiecare dimineață și n-ar mai corespunde cu contabilitatea. Sub total scrie echivalentul în lei și cursul folosit. Prețul unitar acceptă acum patru zecimale: o pungă la 0,4235 lei nu încape în două, iar la 500.000 de bucăți rotunjirea pierdea 1.750 de lei pe o linie.",
   "/comenzi"],

  ["2026-10-27", "Produsul configurat se găsește acum din prima",
   "Butonul care deschide caracteristicile stătea al 41-lea în lista de rezultate, sub patruzeci de produse — practic nu-l vedea nimeni. Acum stă la vedere pe fiecare linie, sub căsuța de căutare, și a urcat primul în listă.",
   "/comenzi/nou"],

  ["2026-10-27", "Comanda se poate modifica, și rămâne scris cine a umblat la ea",
   "Agentul pe al cărui nume stă clientul poate schimba orice comandă a lui — nu doar pe cele plasate de el. Fiecare schimbare intră într-un istoric de pe comandă: ce era, ce a rămas, cine și când. Rândurile alea nu se șterg și nu se corectează. O comandă deja facturată sau livrată se poate și ea modifica, dar îți spune întâi ce urmări are.",
   "/comenzi"],

  ["2026-10-27", "Etichetele AWB se scot în teanc, nu una câte una",
   "Bifă pe fiecare teanc, plus „Selectează tot”, „Doar neprintate” și „Niciuna”. Un buton le trimite pe toate cele bifate la imprimantă, una după alta. Dimineața, după o noapte cu șase emailuri de la Sameday, e o apăsare în loc de șase.",
   "/fulfillment/etichete"],

  ["2026-10-27", "ERP-ul se pune cu iconiță pe telefon",
   "Pe Android apare singur „Instalează aplicația”, pe iPhone e Share → „Add to Home Screen”. Se deschide pe tot ecranul, fără bara de browser. Ținând apăsat pe iconiță ai scurtături direct la Comandă nouă, Comenzi și Scadențe. Nu e o a doua aplicație de întreținut: e tot ERP-ul ăsta, deci orice se schimbă apare și pe telefon în aceeași clipă.",
   ""],

  ["2026-10-27", "Comanda, refăcută pentru telefon",
   "Sub lățimea unui telefon, fiecare linie de comandă devine o cartelă cu numele câmpului deasupra lui; cantitatea, unitatea și prețul stau pe un rând. Butoanele sunt de mărimea unui deget, iar „Salvează comanda” rămâne lipit jos, să nu-l cauți derulând. Pe laptop nu se schimbă nimic.",
   "/comenzi/nou"],

  ["2026-10-27", "Un număr care nu încape în codul produsului se refuză",
   "O lățime de 3500 scrisă în loc de 350, într-un loc de 3 cifre, lărgea codul în tăcere: ieșea un cod de altă lungime, pe care nu-l mai găsea nimeni după. Acum se oprește, cu mesaj. Cum majoritatea familiilor n-au încă minim și maxim scrise, asta e singura plasă care prinde un zero tastat în plus.",
   "/configurari/cod-produs"],

  ["2026-10-27", "Produsul de pe comanda agentului se configurează, nu se tastează",
   "La fiecare linie e „+ Produs nou — configurează-l”: alegi familia, completezi caracteristicile obligatorii, iar codul și denumirea se scriu singure și se văd înainte de salvare. Dacă produsul mai fusese comandat, comanda cade pe ACELAȘI produs — ăsta e tot rostul codului unic, ca stocul să nu se rupă în două. Agentul nu mai poate adăuga un produs doar scriind o denumire; calea aia a rămas doar la administrator.",
   "/comenzi/nou"],

  ["2026-10-26", "Codul produsului are familii, nu o singură listă",
   "Opt familii: folie stretch, pungă curier, sac SGR, plic AWB, sac menajer, bandă adezivă, cutie carton, folie debitată. Fiecare cu caracteristicile ei, fiindcă altfel „Grosime” de la folie s-ar fi amestecat cu „Grosime” de la cartoane. Se adaugă, se schimbă și se șterg familii din Configurări, fără deploy.",
   "/configurari/cod-produs"],

  ["2026-10-26", "Fișa de lot a trecut în engleză",
   "Toată fișa însoțitoare de lot e în engleză, cu româna pe al doilea rând, mai mic. Reprezentantul de vânzări a ieșit de pe ea.",
   "/productie"],

  ["2026-10-26", "La alocare nu mai poți alege un utilaj care n-are ce căuta pe comanda aia",
   "Lista de utilaje se taie la cele din fluxul de producție al comenzii. Regula e și pe server, nu doar în pagină.",
   "/productie"],

  ["2026-10-26", "Planificarea oamenilor pe săptămână, propusă singură",
   "Tu spui ce utilaje merg, câte schimburi și cine poate veni; sistemul împarte oamenii. Ține cont de cine știe să lucreze pe ce utilaj, de orarul fiecăruia și de schimbul din săptămâna trecută, ca să nu sară cineva din noapte în dimineață. Intervalele orare ale schimburilor se scriu de voi.",
   "/productie/program"],

  ["2026-10-26", "La alocare apar doar oamenii care știu utilajul ales",
   "Alegi întâi utilajul, apoi se deschide lista de oameni — și în ea sunt numai cei care au competența pe el și sunt în tură atunci. Verificat și pe server.",
   "/productie"],

  ["2026-10-26", "Fișa de lot arată utilajul alocat și cine poate lucra pe el",
   "Pe fiecare operație se vede utilajul și oamenii alocați, plus câți alții mai sunt calificați pe el dacă e nevoie de schimb.",
   "/productie"],

  ["2026-10-26", "Export Excel la parteneri, doar pentru administratori",
   "Două foi: partenerii cu filtrele puse pe ecran, și o foaie care scrie cum a fost scos fișierul — ca să știi peste o lună ce conține. Agenții nu văd butonul.",
   "/parteneri"],

  ["2026-10-26", "Cod de lot scurt pe fișa de producție",
   "Codul de bare de pe fișă ieșea de 70 mm și nu se citea bine printat. Acum lotul e CM-aammzz-număr, iar foaia se vede mai mare pe ecran, fără să se schimbe nimic la tipărire.",
   "/productie"],

  ["2026-10-26", "Fișa însoțitoare de lot, cu coduri de bare pe fiecare operație",
   "Fișa de producție are etapele din fluxul comenzii, parametrii pe fiecare pas, casete de bun/rebut și câte un cod de bare Code128 pe operație, scanabil de la 203 dpi în sus.",
   "/productie"],

  ["2026-10-26", "Codul unic de produs, generat din caracteristici",
   "Nu se mai scrie de mână. Din Tip + Aplicare + Culoare + Grosime + Lungime iese FSMA10200, iar denumirea se scrie singură. Dacă un cod există deja, salvarea se oprește și îți arată produsul.",
   "/configurari/cod-produs"],

  ["2026-10-26", "Stocuri: căutare pe marfă și filtru pe depozit",
   "Și peste tot în ERP, ultimele intrate apar primele — nu mai cauți la coada listei ce ai scris acum zece minute.",
   "/stocuri"],

  ["2026-10-26", "Comenzile venite pe email nu mai intră direct în registru",
   "Fac un task, nu o comandă. Starea se schimbă din listă, fără să deschizi comanda, iar coloana de furnizor nu mai ocupă jumătate de ecran.",
   "/comenzi"],

  ["2026-10-26", "Capul de tabel rămâne sus, iar tabelele late ies din coloana de text",
   "Pe un monitor larg vezi tot tabelul, nu opt coloane din optsprezece. Bara de derulare orizontală se lipește de marginea de jos a ferestrei, deci e la îndemână fără să cobori peste 400 de rânduri. Primele două coloane rămân pe loc când te duci la dreapta.",
   "/productie"],

  ["2026-10-25", "Parserul de AWB-uri Sameday, pe o rută publică",
   "Jobul de noapte îl poate lua singur. Până acum trebuia pornit de mână.",
   ""],

  ["2026-10-24", "Comenzi producție: ultimele plasate sus, și căutare după client",
   "Căutarea merge și pe numele partenerului, nu doar pe numărul comenzii.",
   "/productie"],

  ["2026-10-23", "Etichete Zebra pentru paleți și locuri de raft",
   "Eticheta unui palet sau a unui loc de raft se scoate direct din ERP, în formatul imprimantei Zebra — fără să mai treacă prin Word și fără să se lipească una peste alta la tipărire.",
   "/stocuri"],

  ["2026-10-22", "Harta depozitului: rafturi, etaje, locuri",
   "Desenată cum arată în hală. Verde liber, galben ocupat, gri blocat — trei culori, fără legendă de învățat.",
   "/stocuri"],

  ["2026-10-21", "Scadențele clientului blochează comenzi noi",
   "Un client pe roșu nu mai primește comandă de la agent. Administratorul poate trece peste, dar conștient.",
   "/scadente"],

  ["2026-10-20", "Livrarea parțială se întreabă la plasarea comenzii",
   "Nu după ce depozitul descoperă că lipsește marfă. Fără răspunsul ăsta, comanda nu se salvează.",
   "/comenzi/nou"],

  ["2026-10-19", "Consumabilele Sameday: zile, prețuri, costuri și marjă",
   "Teancurile de etichete, cantitățile pe zi, costul luat singur din rețetă sau din ultima intrare de marfă.",
   "/fulfillment"],

  ["2026-10-17", "Calculatoare de preț: plic AWB, pungi, cutii",
   "Din materie primă, manoperă și adaos — ca să nu se mai socotească pe hârtie.",
   "/calculator/awb"],

  ["2026-10-15", "Rețete și costuri de producție pe produs",
   "Costul unui produs se recalculează singur la fiecare pornire, din rețetă sau din ultima intrare. O scumpire la furnizor se vede fără să umble cineva.",
   "/productie/retete"],

  ["2026-10-12", "Sincronizare cu SmartBill: facturi emise, încasări, furnizori",
   "Facturile emise, încasările și facturile de la furnizori intră singure în ERP, fără să le mai bată cineva a doua oară. Ce nu se potrivește rămâne la vedere, cu motivul scris pe el, în loc să fie trecut cu vederea.",
   "/admin/sincronizare"],

  ["2026-10-10", "Fluxuri de producție pe produs, cu utilaje și timpi",
   "Fiecare produs are drumul lui prin hală, iar fișa de lot și alocarea îl citesc de acolo.",
   "/fluxuri"],
];

// Rândurile, ca obiecte. Lista de mai sus e scrisă scurt ca să fie ușor de
// adăugat un rând; restul ERP-ului vrea nume, nu poziții.
function toate() {
  return LISTA.map(([data, titlu, text, unde]) => ({ data, titlu, text, unde: unde || "" }));
}

// Ultimele `n`. Vali a cerut 30 — numărul stă aici, nu împrăștiat prin pagină.
function ultimele(n) {
  const cate = Number(n) > 0 ? Math.floor(Number(n)) : 30;
  return toate().slice(0, cate);
}

// Grupate pe zi, pentru ecran: o zi cu trei lucruri nu trebuie să-și scrie
// data de trei ori.
function peZile(lista) {
  const out = [];
  for (const r of lista) {
    const ultim = out[out.length - 1];
    if (ultim && ultim.data === r.data) ultim.randuri.push(r);
    else out.push({ data: r.data, randuri: [r] });
  }
  return out;
}

module.exports = { toate, ultimele, peZile, CATE: 30 };
