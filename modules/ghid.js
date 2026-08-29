"use strict";
// Ghidul de utilizare, chiar în aplicație.
//
// Fiecare pagină are sus-dreapta un link „Cum se folosește" care deschide
// capitolul secțiunii în care se află omul — nu cuprinsul, nu un PDF de
// patruzeci de pagini, ci exact bucata care îi explică ce are pe ecran.
// Textul e același cu cel din ghidul tipărit; se ține într-un singur loc, aici.
const { esc, layout } = require("../lib/render");
const { send } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");

// GHID_DATE
const GHID = [
{
"slug":"start",
"zona":"/profil",
"titlu":"Ce este ERP-ul și cum intri în el",
"intro":"ERP-ul Cash Machine este locul unde stau la un loc clienții, facturile, depozitul, producția și banii firmei. Nu înlocuiește programul de contabilitate — ia datele din el și le arată într-un fel în care poți lucra: cine ce a comandat, ce avem pe stoc, cine ne datorează bani și cât.",
"pagini":[
{
"t":"Intrarea în cont",
"p":[
"Deschizi adresa aplicației în browser (Chrome, Edge, Safari — merge oriunde) și primești ecranul de intrare. Te loghezi cu adresa ta de email de firmă și cu parola primită de la administrator.",
"Prima dată vei fi rugat să îți schimbi parola. Alege una pe care nu o folosești nicăieri altundeva. Parola ta e a ta — nimeni din firmă, nici administratorul, nu are nevoie de ea și nu trebuie să o afle."
],
"pasi":[
"Scrii emailul de firmă (nume.prenume@cashmachine.ro).",
"Scrii parola.",
"Apeși „Intră”.",
"Dacă e prima intrare, îți pui parola nouă și gata."
],
"sfat":"Dacă ai uitat parola, nu încerca de zece ori — cere-i administratorului să ți-o reseteze."
},
{
"t":"Bara de sus: cele opt zone",
"p":[
"Sus, pe toată lățimea ecranului, e meniul principal. Sunt opt zone de lucru: <b>Dashboard, CRM, Depozit, Producție, Financiar, Rapoarte, Configurări</b> și <b>Utilizatori</b>. Fiecare zonă își are propriile pagini, care apar pe al doilea rând de meniu, imediat sub titlu.",
"Nu toată lumea vede toate cele opt. Fiecare om vede doar secțiunile pe care i le-a dat administratorul. Dacă îți lipsește una de care ai nevoie ca să-ți faci treaba, ceri acces — nu e o defecțiune, așa e gândit."
],
"pasi":[],
"sfat":"În colțul din dreapta sus e numele tău. De acolo intri în profil (poză, parolă) și tot de acolo ieși din cont."
},
{
"t":"Profilul tău",
"p":[
"Aici îți pui o poză și îți schimbi parola. Poza apare lângă numele tău sus și în listele unde e nevoie să se vadă cine a făcut ce.",
"Schimbă-ți parola din când în când și oricând ai impresia că a văzut-o altcineva."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"dashboard",
"zona":"/",
"titlu":"Dashboard — ce s-a întâmplat azi",
"intro":"Prima pagină, cea care se deschide când intri. E o privire de ansamblu: cifrele lunii, ce e restant, ce urmează. Nu se lucrează în ea — se citește.",
"pagini":[
{
"t":"Pagina de start",
"p":[
"Sus sunt cifrele mari: cât s-a facturat, cât s-a încasat, ce e restant. Mai jos, graficele pe luni și listele scurte cu ce cere atenție acum — facturi scadente, comenzi în lucru, task-uri.",
"Fiecare cifră și fiecare rând din liste e un link. Dacă vezi „12 facturi restante” și vrei să știi care sunt, dai click pe ea și ajungi direct în listă, deja filtrată."
],
"pasi":[],
"sfat":"Dacă vrei să știi „cum stăm”, aici te uiți. Dacă vrei să știi „de ce”, dai click și mergi mai departe."
}
]
},
{
"slug":"crm",
"zona":"/crm",
"titlu":"CRM — clienți, oferte, comenzi",
"intro":"CRM înseamnă tot ce ține de vânzare: de la un nume auzit la telefon până la comanda semnată. Zona asta e a agenților de vânzări, dar pipeline-ul și partenerii îi interesează pe toți.",
"pagini":[
{
"t":"Pipeline — pâlnia de vânzări",
"p":[
"Pâlnia arată unde se pierd vânzările. Sus intră lead-urile (nume de firme cu care n-am vorbit încă serios), jos ies comenzile. Fiecare treaptă e mai îngustă decât cea de deasupra — asta e normal, nu toate discuțiile se transformă în comandă.",
"Sub fiecare treaptă scrie și cât la sută a trecut din treapta de dinainte. Dacă între „Oferte trimise” și „În negociere” cade brusc, acolo e problema."
],
"pasi":[],
"sfat":"Din dreapta sus poți alege un singur agent, ca să vezi pâlnia lui, nu pe a firmei."
},
{
"t":"Biroul meu",
"p":[
"Pagina ta personală de lucru: ce ai tu de făcut azi. Task-urile tale, clienții tăi care așteaptă un răspuns, ofertele care trebuie urmărite, facturile tale restante.",
"E cea mai utilă pagină pentru un agent. Dacă începi ziua de undeva, de aici o începi."
],
"pasi":[],
"sfat":null
},
{
"t":"Lead-uri",
"p":[
"Lead-ul e o firmă cu care încă nu ai o discuție serioasă: un nume găsit undeva, o cerere venită pe site, o recomandare. Îl treci aici ca să nu se piardă.",
"Când lead-ul devine ceva serios, îl califici și devine oportunitate — intră în pâlnie pe treapta a doua."
],
"pasi":[
"Apeși „+ Lead”.",
"Scrii firma, persoana de contact, telefon sau email, și de unde a venit.",
"Îți pui un task de sunat, ca să nu rămână acolo o lună."
],
"sfat":null
},
{
"t":"Contactări",
"p":[
"Jurnalul discuțiilor. Fiecare telefon dat, fiecare vizită, fiecare mail important se trece aici, scurt: cu cine, când, ce s-a vorbit, ce urmează.",
"Pare muncă în plus. Nu e. Peste trei luni, când clientul zice „dar am vorbit cu voi”, aici e răspunsul — și dacă pleci în concediu, colegul poate prelua discuția fără să sune clientul să-l întrebe unde rămăseserăți."
],
"pasi":[],
"sfat":null
},
{
"t":"Parteneri",
"p":[
"Toate firmele cu care lucrăm: clienți și furnizori, la un loc. Datele lor de identificare, adresele, persoanele de contact, și — cel mai important — istoricul: ce le-am facturat, ce au plătit, ce mai au de plătit.",
"Click pe un partener ca să-i vezi fișa completă."
],
"pasi":[],
"sfat":null
},
{
"t":"Oferte și Contracte",
"p":[
"Ofertele trimise clienților, cu produsele și prețurile lor. O ofertă acceptată se transformă în comandă fără să rescrii nimic.",
"Contractele sunt înțelegerile pe termen mai lung, cu prețuri și condiții agreate."
],
"pasi":[],
"sfat":null
},
{
"t":"Comenzi",
"p":[
"Comenzile primite de la clienți: ce a cerut, cât, pe ce dată, la ce preț și în ce stadiu e. De aici pleacă și producția, și livrarea din depozit.",
"Când scoți marfă din depozit pe o comandă anume, comanda pe care o alegi acolo e una dintre acestea."
],
"pasi":[],
"sfat":null
},
{
"t":"Produse și Calculator preț",
"p":[
"Catalogul de produse, cu unitatea de măsură și prețurile. Calculatorul de preț îți spune la ce preț poți vinde ca să îți iasă marja pe care o vrei, plecând de la costul real.",
"Pune costul, pune marja dorită, îți dă prețul. Sau invers: pune prețul cerut de client și vezi ce marjă rămâne."
],
"pasi":[],
"sfat":null
},
{
"t":"Scadențe",
"p":[
"Cine ne datorează bani și de când. Sortat pe vechime: ce e de plătit azi, ce a trecut de 30 de zile, ce a trecut de 90.",
"Facturile vechi de peste 60 de zile sunt cele care ajung să nu se mai încaseze. Aici le vezi înainte să ajungă acolo."
],
"pasi":[],
"sfat":null
},
{
"t":"Task-uri",
"p":[
"Lista de treburi, a ta și a echipei. Un task are un titlu, un termen și un om.",
"Task-urile tale apar și în „Biroul meu”."
],
"pasi":[],
"sfat":null
},
{
"t":"Comisionul meu",
"p":[
"Pentru agenți: cât ai de încasat ca și comision, calculat din <b>încasările</b> reale, nu din facturi. Adică din banii intrați efectiv în cont.",
"Poți cere și mai puțin decât ai — diferența nu se pierde, se reportează în luna următoare."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"depozit",
"zona":"/depozit",
"titlu":"Depozit — ce avem, ce intră, ce iese",
"intro":"Depozitul e locul unde marfa are adresă. Zona asta răspunde la trei întrebări: ce avem, unde e, și ce trebuie cumpărat.",
"pagini":[
{
"t":"Comenzi deschise",
"p":[
"Comenzile clienților care încă n-au fost livrate. Asta e lista de lucru a depozitului: ce trebuie pregătit și trimis."
],
"pasi":[],
"sfat":null
},
{
"t":"Stocuri & inventar",
"p":[
"Stocul pe fiecare depozit și mișcările de stoc: ce a intrat, ce a ieșit, când și pe ce document.",
"Dacă o cantitate arată ciudat, mișcările de stoc îți spun de unde vine."
],
"pasi":[],
"sfat":null
},
{
"t":"Depozit CT-Park — harta",
"p":[
"CT-Park e depozitul cu rafturi și adrese. E împărțit în <b>rânduri</b>; fiecare rând are <b>câmpuri</b> pe orizontală și <b>niveluri</b> pe verticală, iar în fiecare câmp intră trei paleți. Așa se naște o adresă de forma <b>R1-05-1-1</b>: rândul 1, câmpul 5, nivelul 1, poziția 1.",
"Pagina de hartă îți arată cât e ocupat din fiecare rând. Click pe un rând ca să-i vezi fața și să știi exact ce e în fiecare loc."
],
"pasi":[],
"sfat":"Cifra din bara colorată e cât e ocupat din rândul acela."
},
{
"t":"Intrare marfă",
"p":[
"Când vine marfă în depozit, o înregistrezi aici. Spui ce e, câtă e, din ce lot, și câte locuri de palet ocupă. Sistemul îți dă adresa liberă și îți tipărește eticheta.",
"Eticheta se lipește pe palet. Pe ea scrie mare adresa — după aia nu mai cauți marfa, o găsești."
],
"pasi":[
"Apeși „+ Intrare marfă”.",
"Alegi produsul și scrii cantitatea și lotul.",
"Spui câte locuri ocupă paletul (unele ocupă 2–3).",
"Salvezi. Primești adresa și eticheta, o tipărești și o lipești."
],
"sfat":null
},
{
"t":"Eticheta de intrare",
"p":[
"Așa arată eticheta care se lipește pe paletul intrat. Adresa e scrisă mare, ca să se citească de la câțiva metri. Jos, codul paletului — după el îl cauți în aplicație."
],
"pasi":[],
"sfat":null
},
{
"t":"Ieșire marfă",
"p":[
"Când marfa pleacă din depozit, o scoți de aici. Bifezi paleții care pleacă și — obligatoriu — spui <b>unde se duc</b>. Sunt trei variante:",
"<b>Producție</b> — materie primă care intră în fabricație.<br><b>Fulfillment</b> — marfă care pleacă spre pregătirea comenzilor.<br><b>Comandă</b> — livrare pe o comandă anume; în cazul ăsta trebuie aleasă exact comanda.",
"Fără destinație nu iese nimic din depozit. Locurile se eliberează pe loc, iar la final primești etichetele de ieșire."
],
"pasi":[
"Bifezi paleții care pleacă (poți bifa mai mulți deodată).",
"Alegi destinația: Producție, Fulfillment sau Comandă.",
"Dacă ai ales Comandă, alegi din listă exact ce comandă e.",
"Scrii, dacă vrei, o observație (cine ridică, ce AWB).",
"Apeși „Scoate paleții și tipărește etichetele”."
],
"sfat":"Poți căuta în listă după marfă, cod de paletă sau lot — util când depozitul e plin."
},
{
"t":"Eticheta de ieșire",
"p":[
"Pe eticheta de ieșire scrie mare unde se duce marfa. Când destinația e o comandă, apar și numele clientului, numărul comenzii și data ei — ca cel care încarcă mașina să nu aibă nevoie să întrebe pe nimeni.",
"Mai scrie de unde a plecat paletul (adresa pe care o elibera) și cine l-a scos."
],
"pasi":[],
"sfat":null
},
{
"t":"Eticheta pentru producție și fulfillment",
"p":[
"Când marfa se duce în producție sau în fulfillment, eticheta e mai simplă: destinația mare, marfa, cantitatea, lotul și de unde a plecat."
],
"pasi":[],
"sfat":null
},
{
"t":"Paleți în depozit",
"p":[
"Lista completă a paleților aflați acum în depozit, cu adresa și marfa fiecăruia. De aici cauți un palet anume."
],
"pasi":[],
"sfat":null
},
{
"t":"De aprovizionat și Forecast",
"p":[
"Ce trebuie cumpărat: materia primă cerută de producție și produsele care se apropie de epuizare. Forecastul merge mai departe și estimează ce va fi nevoie, ca să comanzi din timp.",
"Ideea e simplă: să nu afli că nu mai ai folie în ziua în care trebuie să produci."
],
"pasi":[],
"sfat":null
},
{
"t":"Achiziții",
"p":[
"Facturile primite de la furnizori, cu ce s-a cumpărat pe fiecare. De aici se vede costul real al mărfii."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"productie",
"zona":"/productie",
"titlu":"Producție — ce se face și cu ce",
"intro":"Zona de producție ține comenzile în lucru, planificarea pe utilaje și oameni, și legătura cu depozitul pentru materie primă.",
"pagini":[
{
"t":"Comenzi în lucru",
"p":[
"Comenzile de producție deschise: ce se face, cât, pentru ce comandă de client și în ce stadiu. Sus apar comenzile care încă n-au fost alocate nimănui — alea așteaptă o decizie."
],
"pasi":[],
"sfat":null
},
{
"t":"Planificare",
"p":[
"Calendarul producției: ce utilaj e ocupat când, cine lucrează, ce e planificat în perioada asta.",
"Aici vezi dacă mai poți promite un termen unui client sau nu."
],
"pasi":[],
"sfat":null
},
{
"t":"Utilaje și Resurse",
"p":[
"Utilajele din fabrică, cu capacitatea lor, și resursele (oameni, schimburi) pe care se sprijină planificarea."
],
"pasi":[],
"sfat":null
},
{
"t":"Cereri din depozit și Materie primă",
"p":[
"Producția cere materie primă de la depozit prin pagina de cereri. Depozitul o vede, o scoate cu destinația „Producție” și marfa ajunge unde trebuie, cu urmă în sistem.",
"„Materie primă” arată ce a primit producția și ce mai are."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"financiar",
"zona":"/financiar",
"titlu":"Financiar — facturi, bancă, costuri",
"intro":"Banii firmei: ce am facturat, ce am încasat, ce am plătit, cât ne costă echipa. Datele vin în mare parte din programul de contabilitate, prin import.",
"pagini":[
{
"t":"Sumar financiar",
"p":[
"Facturat față de cumpărat, lună de lună. Diferența dintre cele două linii e, simplificat, marja brută a firmei."
],
"pasi":[],
"sfat":null
},
{
"t":"Facturare",
"p":[
"Toate facturile de vânzare, cu partener, dată, valoare, ce s-a încasat din ele și ce a mai rămas. Poți filtra după partener, perioadă sau stare.",
"Click pe o factură ca să-i vezi liniile — produsele de pe ea."
],
"pasi":[],
"sfat":null
},
{
"t":"Bancă — extras și reconciliere",
"p":[
"Încarci extrasul de cont și aplicația potrivește plățile cu facturile. Ce nu se potrivește automat rămâne evidențiat, ca să legi manual.",
"De aici se știe ce s-a încasat cu adevărat — și de aici se calculează comisioanele agenților."
],
"pasi":[],
"sfat":null
},
{
"t":"Angajați, Salarizare, Cost company",
"p":[
"Fișele angajaților, statele de plată și costul lunar al echipei — salarii, mașini, combustibil, telefoane.",
"„Cost company” e cifra care contează când te întrebi cât costă efectiv o lună de firmă."
],
"pasi":[],
"sfat":"Salariile se văd doar de către cei care au acces la secțiunea Financiar."
},
{
"t":"Decont agenți",
"p":[
"Cheltuielile agenților de teren: combustibil, cazare, diurnă. Se strâng pe lună și pe om."
],
"pasi":[],
"sfat":null
},
{
"t":"Import date",
"p":[
"De aici se aduc datele din programul de contabilitate: facturi emise, achiziții, încasări, parteneri, stocuri.",
"Importul e o operațiune de administrator. Se face pe loturi, iar fiecare lot poate fi verificat înainte de a fi aplicat."
],
"pasi":[],
"sfat":"Aplicația <b>citește</b> din contabilitate, nu scrie nimic înapoi în ea."
}
]
},
{
"slug":"rapoarte",
"zona":"/rapoarte",
"titlu":"Rapoarte — răspunsuri la întrebări",
"intro":"Rapoartele sunt întrebări deja formulate. În loc să scoți datele și să le prelucrezi în Excel, alegi raportul și perioada.",
"pagini":[
{
"t":"Lista rapoartelor",
"p":[
"Rapoartele sunt împărțite în trei: <b>financiare</b> (vânzări, încasări, restanțe, TVA, cash-flow, balanță), <b>operaționale</b> (stocuri, produse, forecast) și <b>comerciale</b> (agenți, clienți, comisioane, pipeline).",
"Fiecare raport are un filtru de perioadă sus. Toate se pot exporta."
],
"pasi":[],
"sfat":null
},
{
"t":"Vânzări",
"p":[
"Cât s-a vândut, pe ce perioadă, cui și de către cine. Se poate desface pe agent, pe client sau pe produs."
],
"pasi":[],
"sfat":null
},
{
"t":"Încasări și Restanțe",
"p":[
"Încasările arată banii intrați, pe zile și pe partener. Restanțele arată invers: ce nu a intrat și de cât timp întârzie.",
"Raportul de restanțe e cel pe care îl deschizi înainte să suni un client."
],
"pasi":[],
"sfat":null
},
{
"t":"Indicatori",
"p":[
"Cifrele-cheie ale firmei la un loc: marjă, viteză de încasare, valoare medie a comenzii, evoluție față de anul trecut."
],
"pasi":[],
"sfat":null
},
{
"t":"Clienți și Produse top",
"p":[
"Cine sunt clienții mari și ce produse aduc cel mai mult. Util când te întrebi unde să pui efortul."
],
"pasi":[],
"sfat":null
},
{
"t":"Cash-flow, TVA, Balanță",
"p":[
"Rapoartele contabile: cum arată fluxul de bani pe luni, ce TVA avem de plătit, și balanța importată din contabilitate."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"configurari",
"zona":"/configurari",
"titlu":"Configurări — datele importate",
"intro":"Aici se verifică ce a intrat în aplicație din programul de contabilitate. E o zonă de control, nu de lucru zilnic.",
"pagini":[
{
"t":"Date importate",
"p":[
"Lista completă a facturilor și plăților importate, cu sursa lor. Sus sunt cifrele: câte facturi, câte plăți, pe ce perioadă.",
"<b>Filtrul caută în tot setul de date, nu doar în pagina afișată.</b> Poți căuta după numele partenerului sau după numărul documentului — de exemplu <b>CSHM3157</b>, și merge și cu spațiu (CSHM 3157), și cu litere mici."
],
"pasi":[
"Scrii în căsuța de căutare ce cauți.",
"Apeși „Caută” sau Enter.",
"Rezultatul e din toate documentele, oricâte pagini ar fi."
],
"sfat":null
}
]
},
{
"slug":"utilizatori",
"zona":"/admin/utilizatori",
"titlu":"Utilizatori — cine intră și ce vede",
"intro":"Zona de administrare. O vede doar administratorul. De aici se fac conturile, se dau accesele și se verifică sănătatea datelor.",
"pagini":[
{
"t":"Lista utilizatorilor",
"p":[
"Toți oamenii cu cont în aplicație: numele, emailul, rolul, ce secțiuni văd, comisionul și dacă sunt activi.",
"Un om care pleacă din firmă nu se șterge — se dezactivează. Așa rămâne istoricul lui (cine a scos ce palet, cine a făcut ce factură), dar nu mai poate intra."
],
"pasi":[],
"sfat":null
},
{
"t":"Ce secțiuni vede fiecare",
"p":[
"În fișa fiecărui om, jos, e lista de bife <b>„Ce secțiuni vede”</b>. Sunt exact intrările din meniul de sus: Dashboard, CRM, Depozit, Producție, Financiar, Rapoarte, Configurări, Utilizatori.",
"Bifezi ce trebuie să vadă omul și atât. Ce nu e bifat nici nu apare în meniul lui — nu i se arată o ușă pe care n-o poate deschide.",
"<b>Administratorul vede tot</b>, oricum — nu i se poate lua nimic. Iar cine n-are nicio bifă rămâne pe împărțirea veche a rolului, ca nimeni să nu rămână blocat pe dinafară din greșeală."
],
"pasi":[
"Intri în fișa omului („Editează”).",
"Bifezi secțiunile de care are nevoie.",
"Salvezi. Are efect de la următoarea pagină pe care o deschide."
],
"sfat":"„Configurări” și „Utilizatori” sunt marcate <b>sensibil</b> — dă-le cu cap, acolo se văd toate datele firmei."
},
{
"t":"Verificări date",
"p":[
"Aplicația se verifică singură și îți spune unde datele nu se leagă: facturi încasate peste valoarea lor, plăți identice pe aceeași factură, facturi fără linii, plăți pe facturi anulate.",
"Fiecare verificare are un buton de reparare, dar butoanele nu se apasă la întâmplare — se uită întâi cineva peste listă."
],
"pasi":[],
"sfat":null
},
{
"t":"Backup",
"p":[
"De aici se descarcă o copie a bazei de date. Se face periodic și se ține în afara aplicației."
],
"pasi":[],
"sfat":null
}
]
},
{
"slug":"intrebari",
"zona":null,
"titlu":"Întrebări care apar des",
"intro":"Situațiile care apar cel mai des, cu răspuns scurt.",
"pagini":[
{
"t":"Nu văd o secțiune din meniu.",
"p":[
"Nu ai acces la ea. Cere-i administratorului să-ți bifeze secțiunea în fișa ta."
],
"pasi":[],
"sfat":null
},
{
"t":"Am uitat parola.",
"p":[
"Administratorul ți-o resetează și primești una temporară, pe care o schimbi la prima intrare."
],
"pasi":[],
"sfat":null
},
{
"t":"Am scos din greșeală un palet din depozit.",
"p":[
"Spune-i imediat administratorului. Ieșirea rămâne înregistrată, dar paletul poate fi pus la loc."
],
"pasi":[],
"sfat":null
},
{
"t":"Am scris greșit ceva la intrarea mărfii.",
"p":[
"Intri pe paletul respectiv și corectezi. Dacă eticheta e deja lipită, tipărește-o din nou."
],
"pasi":[],
"sfat":null
},
{
"t":"O factură nu apare în listă.",
"p":[
"Ori nu a fost încă importată din contabilitate, ori filtrul de perioadă e pe altă lună. Verifică întâi perioada."
],
"pasi":[],
"sfat":null
},
{
"t":"Cifrele din ERP nu se potrivesc cu cele din contabilitate.",
"p":[
"ERP-ul arată ce s-a importat până la ultimul import. Dacă în contabilitate s-a lucrat după, diferența e normală până la următorul import."
],
"pasi":[],
"sfat":null
},
{
"t":"Pot strica ceva dacă apăs?",
"p":[
"Butoanele care șterg sau modifică definitiv cer confirmare. Restul doar afișează. Umblă liniștit prin aplicație — se învață uitându-te."
],
"pasi":[],
"sfat":null
}
]
}
];

function capitol(slug) {
  return GHID.find((c) => c.slug === slug) || null;
}

// Cuprinsul arată doar capitolele secțiunilor pe care omul le are în meniu.
// Un capitol despre o pagină pe care n-o poate deschide nu-l ajută cu nimic.
// Capitolul de început și întrebările rămân mereu, n-au zonă.
function capitolePentru(user) {
  return GHID.filter((c) => !c.zona || !user || poateAccesa(user, c.zona));
}

// Textele din GHID conțin marcaje simple scrise de mână (<b>, <br>); orice
// altceva ar fi text scăpat din greșeală, așa că las doar aceste două.
function textBogat(s) {
  return esc(String(s || ""))
    .replace(/&lt;b&gt;/g, "<b>")
    .replace(/&lt;\/b&gt;/g, "</b>")
    .replace(/&lt;br&gt;/g, "<br>");
}

function paginaHtml(p) {
  const parti = [`<div class="ghid-pas"><h3>${esc(p.t)}</h3>`];
  for (const t of p.p) parti.push(`<p>${textBogat(t)}</p>`);
  if (p.pasi && p.pasi.length) {
    parti.push('<div class="ghid-pasi"><div class="ghid-et">Pas cu pas</div><ol>');
    for (const s of p.pasi) parti.push(`<li>${textBogat(s)}</li>`);
    parti.push("</ol></div>");
  }
  if (p.sfat) parti.push(`<div class="ghid-sfat"><b>De reținut:</b> ${textBogat(p.sfat)}</div>`);
  parti.push("</div>");
  return parti.join("");
}

function cuprinsHtml(activ, user) {
  const lista = capitolePentru(user);
  if (activ && !lista.some((c) => c.slug === activ)) {
    const c = capitol(activ);
    if (c) lista.push(c);
  }
  return (
    '<nav class="ghid-cuprins">' +
    lista.map(
      (c) =>
        `<a href="/ghid/${c.slug}" class="ghid-fila${c.slug === activ ? " activ" : ""}">${esc(c.titlu)}</a>`
    ).join("") +
    "</nav>"
  );
}

function register(router) {
  // Cuprinsul: capitolele, în ordine, cu ce conține fiecare.
  router.get("/ghid", async (ctx) => {
    const corp =
      cuprinsHtml(null, ctx.user) +
      '<p class="ghid-intro">Ghidul e împărțit exact ca meniul de sus. Din orice pagină ' +
      'a aplicației ajungi direct la capitolul ei, cu link-ul <b>„Cum se folosește”</b> ' +
      "din dreapta titlului.</p>" +
      '<div class="ghid-lista">' +
      capitolePentru(ctx.user).map(
        (c, i) =>
          `<a href="/ghid/${c.slug}" class="ghid-card">
             <span class="ghid-nr">${i + 1}</span>
             <span class="ghid-card-titlu">${esc(c.titlu)}</span>
             <span class="ghid-card-desc">${esc(c.intro)}</span>
             <span class="ghid-card-cate">${c.pagini.length} ${c.pagini.length === 1 ? "subiect" : "subiecte"}</span>
           </a>`
      ).join("") +
      "</div>";
    send(ctx.res, 200, layout({ title: "Cum se folosește ERP-ul", active: "/ghid", body: corp, user: ctx.user }));
  });

  router.get("/ghid/:slug", async (ctx) => {
    const c = capitol(ctx.params.slug);
    if (!c) {
      return send(
        ctx.res,
        404,
        layout({
          title: "Capitolul nu există",
          active: "/ghid",
          body: cuprinsHtml(null, ctx.user) + '<p class="ghid-intro">Alege un capitol din lista de mai sus.</p>',
          user: ctx.user,
        })
      );
    }
    const lista = capitolePentru(ctx.user);
    const i = lista.indexOf(c);
    const inainte = i > 0 ? lista[i - 1] : null;
    const dupa = i >= 0 && i < lista.length - 1 ? lista[i + 1] : null;

    const corp =
      cuprinsHtml(c.slug, ctx.user) +
      `<p class="ghid-intro">${textBogat(c.intro)}</p>` +
      (c.zona ? `<p class="ghid-inapoi"><a href="${c.zona}">← Înapoi la ${esc(c.titlu.split(" —")[0])}</a></p>` : "") +
      c.pagini.map(paginaHtml).join("") +
      '<div class="ghid-vecini">' +
      (inainte ? `<a href="/ghid/${inainte.slug}">← ${esc(inainte.titlu)}</a>` : "<span></span>") +
      (dupa ? `<a href="/ghid/${dupa.slug}">${esc(dupa.titlu)} →</a>` : "<span></span>") +
      "</div>";

    send(ctx.res, 200, layout({ title: c.titlu, active: "/ghid", body: corp, user: ctx.user }));
  });
}

module.exports = { register, GHID };
