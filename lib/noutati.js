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
  ["2026-11-09", "Comanda: furnizorul se cere doar când produsul e pe stoc; altfel îl alege producția, la alocarea materialului",
   "Pe comandă, Furnizorul ales dintr-o listă nu mai e o caracteristică a produsului: la Folie stretch panoul „configurează” nu-l mai cere, deci produsul se pune pe comandă și când n-are cine să-l aleagă. Unde furnizorul e scris ca text în produs (WBVFOL01), rămâne cum era: acolo face parte din produs. După ce alegi produsul, ERP-ul se uită în CT-Park. Dacă e pe stoc și paleții au furnizorul scris, sub produs apare lista „Furnizor”, obligatorie, cu furnizorii de pe stoc și cât are fiecare; depozitul vede apoi pe comandă de pe ce paleți scoate. Dacă nu e pe stoc, sub produs scrie că furnizorul se alege în producție, iar linia pleacă fără el. În producție, pe comanda de producție și pe „Necesar de materie primă”, e caseta „Furnizorul materialului”: întâi furnizorii de pe stocul materialelor din rețetă, apoi căutare în toți furnizorii. Ce alegi acolo ajunge pe linia clientului care n-avea furnizor (scrie „din producție” și intră în istoricul comenzii) și, la recepția din producție, pe paleții care ies. Necesarul arată acum și furnizorul fiecărui palet. Când depozitul comandă de la un furnizor anume pentru o linie fără furnizor, linia îl primește și ea. La modificarea unei comenzi, liniile vechi nu sunt oprite pentru furnizor și își păstrează ce aveau.",
   "/comenzi/nou"],

  ["2026-11-06", "Comenzi: filtre ca în Excel în capul tabelului",
   "În lista de comenzi, fiecare coloană (Nr., Client, Data, Data solicitată, Confirmată de producție, Status, Total) are un ▾ lângă nume. Din el bifezi ce vrei să vezi, cu numărul de comenzi lângă fiecare valoare, sau cauți: scrii „11.2026” și Enter păstrează doar luna noiembrie. Filtrele de pe mai multe coloane se adună, iar lista unei coloane arată doar ce a rămas după celelalte: alegi un client și la Status vezi doar statusurile lui. La date contează ziua, nu ora. Deasupra tabelului scrie câte comenzi se văd și totalul lor în lei, lângă butonul „Șterge filtrele”. Filtrul rămâne pus când intri într-o comandă și te întorci în listă; dispare doar când închizi fereastra.",
   "/comenzi"],

  ["2026-11-05", "Coduri de bare pe aviz și pe etichete; scanezi oriunde în ERP și se deschide ce ai scanat",
   "Avizul are acum cod de bare sub serie și număr, la client codul comenzii și AWB-ul transportului (când curierul i-a dat unul), iar pe fiecare linie, lângă denumire, codul produsului. Eticheta paletului din CT-Park (100 × 150, Zebra) are codul produsului și codul paletului ca bare, nu doar ca text. Eticheta A4 de ieșire are în plus codul comenzii și al avizului. Comanda către furnizor are numărul ca cod de bare, pentru recepție. Fișa produsului îi arată codul de bare și are butonul „Etichetă cu cod de bare”, o etichetă de 100 × 150 pentru cutii și rafturi. Formele codurilor: produsul, cu codul lui (fără cod, P-12); comanda, CMD-142; avizul, CHMA-1389; paletul, CT261105-0012; comanda la furnizor, CF-2026-0001. Scanarea: cu cititorul de coduri scanezi pe orice pagină din ERP (cât timp nu ești într-o căsuță de scris) și se deschide singur produsul, comanda, avizul, paletul, producția (codul de pe fișa de lot), comanda la furnizor, transportul sau AWB-ul din fulfillment. Dacă un cod se potrivește la mai multe, apare lista lor. Butonul „Scanează” din bara de sus are căsuța pentru cod și, pe telefoanele Android, „Scanează cu camera”. Se deschide doar ce ai voie să vezi: produsul scanat de cineva de la depozit duce la stocul din CT-Park. Fișa produsului arată stocul cum e: CT-Park, cu paleții și locurile lor, și separat fulfillment, fără tabelul vechi pe depozite.",
   "/scan"],

  ["2026-11-05", "Recepția duce marfa în CT-Park: pe raft, cu locul ales, sau direct la livrare",
   "Rândul de recepție nu mai cere un loc din lista veche de rafturi: depozitul e unul singur, CT-Park. După ce finalizezi recepția apare secțiunea „Unde pui marfa — CT-Park”. Pentru fiecare rând bun scrie cât a venit, cât e deja în CT-Park (paleții, cu adresa lor) și cât mai e de pus. „Pune în CT-Park” deschide Intrarea marfă cu produsul, cantitatea, lotul, prețul și furnizorul deja scrise. Tu alegi rândul, nivelul, câmpul și poziția (sau ERP-ul propune), iar la final ies etichetele paleților. „Direct la livrare” nu mai urcă marfa pe raft: deschide ieșirea din CT-Park cu marfa bifată și destinația aleasă. Pentru comanda unui client, cu avizul de însoțire; pentru fulfillment sau producție, cu eticheta de ieșire. Paleții rămân legați de recepție, deci aceeași marfă nu se poate pune sau trimite de două ori, iar stocul nu se dublează.",
   "/depozit/receptie"],

  ["2026-11-05", "Logistică: cursa se poate închide și fără transportator — ridicată de client, agent, camion propriu, dubă sau altă modalitate",
   "Pe pagina cursei, sub transportatori, e secțiunea nouă „Altfel decât cu un transportator”. Alegi cum ajunge marfa: ridicată de client, distribuită de agentul de vânzări (alegi agentul, iar cel de pe comandă e propus), camion propriu, dubă mică sau altă modalitate, unde scrii liber care e. Opțional se scriu mașina sau șoferul și un cost estimat. Cursa trece pe „alocată”, iar în coada logisticii, la „Cu cine”, scrie cum pleacă marfa. Când o ridică clientul nu mai e „Pe drum”, ci un singur buton, „Ridicată — clientul a luat marfa”, care o închide. Comanda clientului trece pe „livrată” singură, ca la transportatori. „Schimbă modalitatea” o readuce la „de alocat”.",
   "/logistica"],

  ["2026-11-05", "Codul produsului: caracteristică cu text liber (furnizor, denumire), din care codul ia primele 2–3 litere",
   "În Configurări → Codul produsului, o caracteristică poate fi acum și „text liber”. La produs scrii ce vrei, de exemplu numele furnizorului, iar în cod intră primele 2 sau 3 litere, cât setezi tu. „S.C.” din fața numelui de firmă se sare. La categoria nouă de produs e și pornirea „furnizor + denumire (text liber)”: din WBV GmbH · Folie aluminiu iese codul WBVFOL01. Primele litere nu sunt unice, așa că la final codul primește un număr de ordine: alt produs cu aceleași litere devine WBVFOL02. Produsul existent se recunoaște după tot textul scris, nu după litere. „S.C. WBV GMBH · folie aluminiu” cade pe WBVFOL01 și nu se mai face a doua oară, iar o comandă cade pe el. La Produs nou și pe comandă, căsuța de text are sugestii: ce s-a mai scris și, la Furnizor, furnizorii din Parteneri. Un cod scris de mână care arată la fel nu e lovit. Numele produsului e denumirea, fără furnizor („Folie aluminiu”); bifa nouă „intră în denumire” se poate schimba la fiecare caracteristică. Când numele scris la Furnizor e o firmă din Parteneri, produsul se leagă de ea și o vezi pe fișa produsului.",
   "/configurari/cod-produs"],

  ["2026-11-05", "Comanda zilnică Sameday se face singură când se urcă ziua, iar Gabi are raportul Sameday",
   "Când se urcă o zi în raportul Comenzi Sameday (din „Comenzi aprobate” sau din AWB-uri), ERP-ul face singur comanda zilei pentru DELIVERY SOLUTIONS S.A., cu produsele și prețurile zilei, cum o scria Gabi de mână. Comanda are numărul „Sameday zz.ll.aaaa”, data cerută e ziua respectivă, iar agentul e cel de pe ultima comandă a clientului. O zi are o singură comandă: dacă ziua se urcă a doua oară, de Gabi sau automat, chiar și în aceeași clipă, nu apare a doua comandă. Dacă la a doua urcare cifrele s-au schimbat, comanda se pune la zi cât timp e încă „nouă”, iar schimbările intră în istoricul ei. O comandă confirmată nu mai e rescrisă de un import. Dacă Gabi a scris deja de mână comanda zilei, ERP-ul o ia pe aceea și nu face alta. Produsele din raport care nu sunt legate la nomenclator nu pot intra pe comandă, iar pagina de după urcare le spune pe nume. În Utilizatori e bifa nouă „Comenzi Sameday (doar raportul)”: cine o are vede și urcă raportul Sameday, fără celelalte rapoarte. Îl găsește în Comenzi → Comenzi Sameday.",
   "/rapoarte/comenzi-la-zi"],

  ["2026-11-05", "Depozit: linia deja comandată are butonul verde „✓ Comandat”",
   "Pe comanda unui client, în depozit, butonul „Comandă” al unei linii devine verde și scrie „✓ Comandat” după ce ai cerut marfa pentru ea, de la un terț sau din producție. Dedesubt scrie ce s-a cerut, de unde, în ce stare e cererea, când și cine a cerut-o. Dacă mai apeși o dată, ERP-ul te întreabă înainte, cu totalul deja comandat pe linie, ca marfa să nu se comande de două ori. O cerere anulată sau refuzată nu mai ține butonul verde. Când comanda zilei Sameday se pune la zi dintr-un import, liniile își păstrează locul, deci butonul verde rămâne pe ele.",
   "/depozit"],

  ["2026-11-05", "Comanda către furnizor: orarul de descărcare și totul în engleză pentru furnizorii din afară",
   "Pe PDF și în email apare singur orarul de descărcare: luni – vineri, 09:00 – 17:30 (în engleză: Monday to Friday). La furnizorii din afară, adică cei cu CIF care nu începe cu RO, cum e WBV (DE…), butonul „Export PDF” și emailul pornesc direct în engleză. Varianta în română rămâne la un click. Versiunea în engleză e tradusă toată: etichetele, unitățile (rolă → roll, buc → pcs, palet → pallet, cutie → box, bax → case) și adresa firmei, cu „Romania” la final. Numerele sunt scrise englezește (84,672 role, 0.23 EUR), ca furnizorul să nu citească 84.672 drept 84 virgulă ceva. Denumirile pozițiilor rămân cum le scrieți. Tabelul de poziții din formular are acum rândurile aliniate.",
   "/procurement/comenzi"],

  ["2026-11-05", "Comanda către furnizor: moneda cu cursul vostru, lei și euro, PDF și modificare cu istoric",
   "Pe comanda către furnizor alegeți moneda: RON, EUR, USD sau oricare altă monedă publicată de BNR. Cursul îl puneți voi, cel negociat cu banca sau cu furnizorul. Câmpul vine completat cu cursul BNR din ziua comenzii, iar dacă îl lăsați gol se ia BNR-ul. Cursul rămâne scris pe comandă și nu se mai schimbă singur când se mișcă euro. Lângă el scrie cu cât diferă de BNR. Valoarea se calculează automat în lei, iar la comenzile în lei și în euro: pe fiecare poziție, pe comandă și în listă, unde sunt și totalurile în lei și în euro. Pe pagina comenzii sunt butoanele „Export PDF” și „PDF în engleză”: se deschide comanda gata de tipărit, din care alegeți „Salvează ca PDF”. Emailul către furnizor se poate scrie și în engleză. Butonul „Modifică comanda” schimbă furnizorul, datele, moneda, cursul, observațiile și pozițiile (adăugate, schimbate sau șterse). Îl au administratorii, depozitul, financiarul și cine a scris comanda. Tot ce se schimbă intră în istoricul de la baza comenzii: cine, ce, cum era, cum a rămas și când, în ora României. La fel crearea, trimiterea pe email, recepția și anularea. O poziție pe care a intrat deja marfă nu se poate șterge, iar o comandă anulată nu se mai modifică. Dacă modificați o comandă deja trimisă, pagina vă spune că furnizorul are încă varianta veche.",
   "/procurement/comenzi"],

  ["2026-11-05", "Categorii de produs noi, definite de voi, cu codul generat din ele",
   "În Configurări → Codul produsului e acum la vedere butonul „+ Categorie nouă de produs” (până acum era un link mic, ascuns). O categorie se face goală sau copiată după una care seamănă, cu toate caracteristicile și valorile ei. Pe pagină sunt scriși pașii: caracteristicile (care intră în cod, în ce ordine, câte cifre), apoi valorile, fiecare cu bucata ei de cod. Pagina spune ce mai lipsește și când categoria e gata de folosit, cu link direct spre Produs nou, unde codul iese singur. Dacă începutul codului e același cu al altei categorii (o copie pornește așa), apare un avertisment, fiindcă două produse diferite ar putea ieși cu același cod. Valorile se pot acum și modifica (denumire, bucată de cod, UM), nu doar adăuga și șterge, iar categoriile se pot redenumi. O categorie care are deja produse nu se șterge de tot: iese din uz, iar produsele ei rămân cum sunt.",
   "/configurari/cod-produs"],

  ["2026-11-05", "Comanda își urmează singură drumul: producție → depozit → livrare",
   "Statusul comenzii clientului merge acum pe tot drumul: nouă → în producție → producție finalizată → în stoc depozit → gata de livrare → facturată → în livrare → livrată. Când producția pune „Finalizată” (din listă sau din fișă), comanda clientului trece pe „producție finalizată”, abia când sunt gata toate comenzile ei de producție. Depozitul primește marfa automat la „De preluat din producție”: pe pagina Depozit → Comenzi deschise, pe comanda din depozit și ca bandă pe harta CT-Park. Când depozitul finalizează recepția, comanda trece pe „în stoc depozit” și agentul o poate factura. Butonul nou „Gata de livrare” din depozit o trimite în Logistică, iar pe cursa de transport sunt butoanele „Pe drum” și „Livrată”, care duc comanda pe „în livrare” și „livrată”. Fiecare pas se scrie în istoricul clientului, deci agentul îl vede fără să întrebe. Dacă producția pune „Finalizată” din greșeală și revine, comanda se întoarce, iar recepția neîncepută se anulează. O comandă de producție anulată nu mai anulează comanda clientului: o pune pe „așteaptă marfă”, iar depozitul vede cererea refuzată. Comenzile puse pe „Finalizată” înainte de schimbare apar pe pagina Producție, la admin, cu butonul „Du-le mai departe”, care le aduce la zi.",
   "/depozit"],

  ["2026-11-05", "Stoc la zi (CT-Park): export în Excel, pentru administratori",
   "Pe pagina Depozit → CT-Park → Stoc la zi, administratorii au butonul „Export Excel”. Fișierul are exact paleții de pe ecran; dacă ai pus o căutare, doar pe cei găsiți. Coloanele: categorie, marfă, cod produs, cod palet, lot, cantitate, UM, furnizor (cel dedus din facturi e marcat așa), data intrării, locul (rând, câmp, nivel), prețul de intrare pe UM, valoarea și de unde e prețul. Cantitățile, prețurile și datele sunt numere și date adevărate, deci se pot sorta, filtra și aduna în Excel. A doua foaie are totalurile pe categorii, iar a treia spune cine a scos fișierul, când și cu ce căutare. Ceilalți utilizatori nu au butonul: fișierul are furnizorii și prețurile întregului depozit.",
   "/stocuri/ct-park/stoc"],

  ["2026-11-04", "Produs nou: codul se generează singur, iar formularul are tot",
   "Butonul „+ produs nou” din Produse deschide acum configuratorul. Alegi familia și caracteristicile ei din Configurări → Codul produsului, iar codul se generează după regula familiei. Căsuța în care se scria codul de mână nu mai există. În același formular completezi și fișa produsului: denumirea (pornește din caracteristici, dar o poți schimba), categoria, gestiunea, unitatea de măsură, prețul de achiziție, costul de producție, adaosul, prețul minim, prețul de vânzare, cota de TVA și stocul minim. Nu mai trebuie să intri după aceea în Editare. Prețurile se pot scrie cu virgulă. Dacă ceva nu e bun (un preț scris greșit, o caracteristică lipsă sau un produs care există deja), formularul revine cu tot ce ai scris și cu motivul deasupra. Un produs care nu se potrivește în nicio familie se adaugă întâi ca familie nouă, în Configurări. La produsele existente, Editarea a rămas cum era.",
   "/produse/nou-cu-cod"],

  ["2026-11-03", "Configurator: hârtie (cutie sau top) și banda adezivă personalizată",
   "La „Produs nou” (din Produse și de pe comandă, „Produs nou — configurează-l”) e familia nouă „Hârtie”: alegi formatul (A4 / A3), gramajul (g/m²) și ambalarea — „Cutie (5 topuri)” sau „Top”. Cutia și topul sunt produse diferite, cu coduri diferite (ex. HCA4080C și HCA4080T), iar unitatea de măsură se pune singură: cutie sau top, orice scria în căsuța de UM. La banda adezivă e câmpul nou, obligatoriu, „Personalizare”: Nepersonalizată, Personalizată FRAGIL sau Personalizată custom cu 1–4 culori. Banda nepersonalizată își păstrează codul de până acum, deci comanda cade pe produsul existent; FRAGIL și custom au coduri proprii (…F, …C1–C4). Dacă nu alegi personalizarea, produsul nu se pune pe comandă. În Configurări → Codul produsului, la fiecare valoare se poate scrie și unitatea de măsură pe care o dă produsului.",
   "/produse/nou-cu-cod"],

  ["2026-11-03", "Nr. Reg. Com. al clienților: completat din ANAF, pe aviz și pe factură",
   "Fișa fiecărui partener are acum câmpul „Nr. Reg. Com.”. Pe pagina Parteneri, administratorul are butonul „Completează Reg. Com. din ANAF”: ERP-ul ia numărul după CUI, din registrul public ANAF, pentru toți partenerii români care nu-l au încă. Ce e deja scris nu se schimbă. Numărul apare pe avizul de însoțire, la client, și pleacă la SmartBill pe factură. Din SmartBill nu se poate lua, pentru că API-ul lor nu dă lista de clienți. ANAF e oricum sursa din care își ia și SmartBill datele.",
   "/parteneri"],

  ["2026-11-03", "Avizul de însoțire a mărfii, fără prețuri: automat la livrarea din depozit și manual din Avize",
   "Când scoți marfă din depozit pe o comandă de client, în loc de etichete se emite avizul de însoțire a mărfii, în formatul celui din SmartBill. Are furnizorul, clientul (nume, CIF, adresă), seria, numărul, data și numărul comenzii, iar dedesubt toate produsele care au plecat, cu denumirea întreagă, U.M. și cantitatea. Nu are prețuri, valori, TVA sau total. La ieșirea parțială, pe aviz intră doar ce a plecat. Din pagina nouă „Avize” (în Financiar și în Depozit, pentru cine are bifa „Avize”) poți face și un aviz manual: alegi clientul și adaugi produse din catalog sau scrise liber. Numerotarea e una singură pentru toate avizele și continuă de la avizele din SmartBill: seria CHMA, începând cu nr. 1389. Un aviz greșit nu se șterge: administratorul îl anulează, iar numărul lui rămâne folosit.",
   "/avize"],

  ["2026-11-03", "Eticheta de ieșire din depozit e acum o foaie A4, cu cod de bare și denumirea întreagă a produsului",
   "Când scoți paleți din depozit (spre producție, fulfillment sau o comandă), eticheta care se tipărește e acum o foaie A4, citibilă de la distanță. Are destinația cu litere mari, clientul și comanda (la livrări), denumirea completă a fiecărui produs care a plecat, cu cantitatea, și codul de bare al produsului. Jos are codul de bare al paletului (de exemplu CT261030-0058). La un palet cu mai multe produse apar toate, iar literele se micșorează ca să încapă pe foaie, fără ca vreo denumire să se taie. Eticheta de depozit rămâne de 100 × 150 mm, pentru Zebra. Un palet din care a plecat doar o parte stă tot pe raft, deci butonul „Etichetă” îi dă de acum eticheta lui de depozit, nu una de ieșire.",
   "/stocuri/ct-park/iesire"],

  ["2026-11-03", "Lead-urile se pot exporta în Excel (doar administratorii)",
   "Pe pagina Lead-uri, administratorii au butonul „↓ Export Excel”. Fișierul are toate lead-urile din filtrul pus (căutare și stadiu), nu doar cele 300 de pe ecran: nume, companie, persoană de contact, email, telefon, sursă, stadiu, agent, scor, clientul din ERP (la cele convertite), data creării, ultima activitate și observațiile. A doua foaie spune ce filtru era pus, când și de cine a fost scos. Pentru ceilalți utilizatori butonul nu apare, iar adresa exportului e refuzată.",
   "/crm/leaduri"],

  ["2026-11-03", "Comenzile clienților cu restanțe nu mai sunt blocate — doar se spune că au întârzieri la plată",
   "Un client cu facturi trecute de scadență poate primi comandă de la oricine, ca orice alt client, inclusiv din oferta acceptată. Nu mai apare „Comandă blocată”. În schimb, când alegi clientul în comanda nouă, sub căsuță scrie cu roșu „Clientul are întârzieri la plată”, cu suma trecută de scadență și câte zile are cea mai veche factură întârziată. Același mesaj stă sus pe pagina comenzii cât timp restanța există; după ce clientul plătește, dispare singur. Din emailul automat de restanță a ieșit fraza „livrările noi sunt suspendate”, fiindcă nu mai e adevărată.",
   "/comenzi/nou"],

  ["2026-11-01", "Rețeta pentru produsele făcute în SmartBill pe mai multe bucăți (de exemplu plicurile, la mia)",
   "Pe pagina rețetei e un câmp nou: „Un bon de producție din SmartBill înseamnă … bucăți”. La produsele scrise în SmartBill la mia, cum sunt plicurile AWB C5 CM, scrii 1000. Cantitățile de acum din rețetă se împart la 1.000, iar costul se recalculează pe loc. De acum, importul din SmartBill împarte consumul la bucățile reale, deci nu mai aduce înapoi rețeta pe 1.000 citită pe un singur plic. Produsele la care nu scrii nimic rămân ca înainte.",
   "/productie/retete"],

  ["2026-10-30", "Agenții de vânzări văd stocul la zi din Depozit",
   "Agenții de vânzări au acum butonul „Depozit” în bara de sus, care îi duce direct la „Stoc la zi”: ce marfă e în depozit, câtă, când a intrat și pe ce raft stă, cu căutare după denumire, cod, lot și adresă. Restul Depozitului (harta, intrarea, mutarea, ieșirea, configurarea) nu li se deschide, iar butonul „Intrare marfă” li se vede, dar e inactiv. Ca la Cereri de preț, agentul nu vede furnizorul și prețul de intrare. Cine are bifa „Depozit” vede tot, ca până acum.",
   "/stocuri/ct-park/stoc"],

  ["2026-10-30", "Paginile folosesc toată lățimea ecranului",
   "Paginile ERP-ului nu mai stau prinse într-o coloană de 1100px la mijloc: se lățesc singure cât e fereastra, pe laptop, pe monitor lat sau pe telefon. Harta depozitului, „Tot depozitul” și tabelele mari folosesc acum tot ecranul, fără loc gol în stânga și în dreapta. Textele lungi și formularele își păstrează lățimea lor, ca să se citească ușor.",
   ""],

  ["2026-10-30", "„Tot depozitul”: toate rândurile, desenate unul sub altul",
   "Submeniu nou în Depozit: „Tot depozitul”. Toate rândurile apar unul sub altul, desenate exact ca pe pagina fiecărui rând — aceleași culori pe marfă, aceleași intervale F și L, paleții lați ca o căsuță dublă sau triplă, aceeași fișă la mouseover —, fără „Zone pe categorii”. Click pe un palet deschide pagina lui (adaugi, scoți, extinzi); click pe un loc liber te duce la intrarea de marfă cu locul ăla deja ales; click pe numele rândului deschide rândul.",
   "/stocuri/ct-park/tot"],

  ["2026-10-30", "Culori cât mai diferite între ele pe harta depozitului",
   "Culorile paleților vin acum dintr-o paletă de 40 de culori alese anume să fie cât mai diferite între ele, iar fiecare marfă din depozit primește o culoare pe care n-o mai are nicio altă marfă (cât timp sunt sub 40 de mărfuri diferite). O marfă își păstrează culoarea de la o zi la alta și pe orice rând; una nouă ia prima culoare liberă. Pe culorile închise textul e alb, pe cele deschise negru, ca să se citească.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Un palet din raft se poate extinde pe locul de lângă (sau elibera), fără să-l scoți",
   "Pe pagina paletului (click pe el pe hartă), sub butoane: „Ocupă 1 loc / 2 locuri / 3 locuri”. Un palet pus pe un singur loc se extinde pe locul de lângă sau pe următoarele două; unul pus pe trei se strânge pe două sau pe unul și eliberează restul. Implicit ia locul liber de lângă, întâi spre dreapta; se poate cere anume partea din dreapta sau din stânga. Locurile rămân lipite, în același câmp și nivel. Dacă lângă e altă marfă, un loc scos din uz sau capătul câmpului, nu se schimbă nimic și spune de ce. Paletul rămâne același — dată, lot, preț — doar adresa lui se schimbă, deci eticheta se retipărește.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Pe harta depozitului, aceeași marfă are aceeași culoare peste tot",
   "Paleții nu mai sunt colorați după categorie, ci după marfă: același cod de produs are aceeași culoare pe orice rând și pe orice nivel, așa că se vede dintr-o privire unde stă aceeași marfă. Marfa fără cod ia culoarea după denumire; un palet cu mai multe produse e gri dungat. Legenda de culori a plecat. Culorile sunt alese automat din cod, deci un produs nou primește singur culoarea lui, iar aceeași marfă o păstrează mereu.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Harta rândului: F și L pentru intervalele în plus de la bază, număr peste număr pe toate nivelurile",
   "Un rând care are la bază un interval în plus în față și/sau în spate (cum e rândul 1: unul cu un palet în față, unul cu doi paleți în spate, doar pe nivelul de jos) le arată pe desen ca F (primul) și L (ultimul), iar celelalte intervale sunt numerotate de la 1, la fel pe toate nivelurile — deci numărul de sus stă exact peste cel de jos. La rândul 1, câmpul 11 avea un singur nivel; acum are 3 × 3 ca restul, deci sus sunt 10 intervale, 1–10. Adresele locurilor (R1-02-1-1 …) rămân cele de până acum.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Click pe un palet din raft: adaugi sau scoți marfă de pe el",
   "Pe pagina paletului (se deschide cu click pe el pe hartă) sunt acum, sus, două formulare. „Adaugă marfă pe palet”: cât pui în plus pe fiecare produs de pe palet — fără preț scris, intră cu prețul paletului; cu alt preț, paletul ia media ponderată, ca valoarea lui să rămână corectă — plus „alt produs pe palet”, căutat după codul vostru, apoi după denumirea exactă (altfel rămâne scris liber). Fiecare adăugare rămâne scrisă: cine, când, cât, cu ce preț. „Scoate marfă de pe palet”: cât pleacă și cât rămâne, numărat — cele două trebuie să dea cât e în sistem —, și unde se duce (producție, fulfillment sau comanda anume). Costul iese cu prețul paletului. Dacă nu mai rămâne nimic, paletul iese din depozit și locul se eliberează; altfel stă pe loc. Ce nu se închide nu schimbă nimic și spune de ce.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Harta rândului: câmpurile stau unul sub altul, iar paletul lat e o poziție dublă sau triplă",
   "Pe harta unui rând, câmpurile nu mai pleacă spre dreapta de la un nivel la altul: un palet cu un cuvânt lung în denumire lățea tot nivelul lui, așa că pe laptop coloanele nu mai stăteau una sub alta. Acum fiecare câmp stă fix sub cel de deasupra, pe toate nivelurile, iar textul lung se rupe în căsuță (fișa de la mouseover îl arată întreg). Tot acum: un produs care ține 2 sau 3 locuri lipite se vede ca o singură căsuță dublă sau triplă, cu eticheta „1–2” sau „1–3”, nu ca două-trei căsuțe separate; marginile ei se potrivesc cu locurile de deasupra și de dedesubt.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Codul scris de voi la produs nou rămâne codul produsului peste tot",
   "Codul pe care îl scrieți la Produs nou e cel care se vede în comenzi, stoc, CT-Park, etichete și producție. Ce s-a schimbat: (1) un cod poate fi pe un singur produs — la Produs nou și la Editare, un cod care e deja pe alt produs (și codul generat din caracteristici al altuia) e refuzat, cu numele produsului care îl are, iar formularul rămâne completat; literele mici și spațiile de la capete nu fac alt cod; cele câteva coduri care stau deja pe două produse nu vă opresc să schimbați un preț, se rezolvă la Unificarea codurilor; (2) importul de produse din SmartBill nu mai pune codul lor peste al vostru — îl completează doar unde lipsește, iar câte coduri au fost păstrate apare în rezultatul importului; (3) comanda arată codul din fișa produsului, nu pe cel generat, dacă l-ați schimbat; (4) după Unificarea codurilor, paleții din CT-Park, recepțiile, ieșirile și stocul pe locuri trec pe produsul păstrat, iar „Produs nou — configurează-l” cade pe produsul păstrat, nu pe cel dezactivat.",
   "/produse"],

  ["2026-10-30", "Pe harta rândului, la mouseover pe un palet apare fișa lui",
   "Ții mouse-ul pe un loc ocupat și vezi tot despre paletul de acolo: codul, adresele (la un palet lat, toate), produsul cu codul lui, cantitatea, lotul, categoria, furnizorul, când a intrat și de câte zile stă, prețul de intrare și de unde e luat, valoarea, cine l-a pus și observațiile; la un palet cu mai multe produse, fiecare cu cantitatea lui. Click-ul duce în continuare la fișa completă a paletului. Tot acum: bara „Pune marfă pe locurile astea”, bara „Mută aici” și banda de editare pe câmp stăteau la vedere tot timpul, deși trebuiau să apară doar când alegi locuri sau când editezi raftul — bara de marfă se putea apăsa fără niciun loc ales, iar butoanele − / + ale benzii schimbă raftul pe loc. Acum apar doar când e cazul.",
   "/stocuri/ct-park"],

  ["2026-10-30", "Intrarea de marfă în CT-Park: nu mai cade, ține locul ales, și fiecare palet cu cantitatea lui",
   "„Ocupă spațiul și fă etichetele” cădea cu „cuFurnizorLaIntrare is not defined” — o variabilă din pasul dinainte —, deci nu se salva nimic, nici marfa, nici locul ales pe hartă. Reparat. Pagina de intrare are acum câte un rând pe palet: rând, nivel, câmp, poziție, câte locuri ocupă (1–3), câți paleți și cât pe palet, cu totalul sub tabel. Venit de pe hartă, rândurile sunt deja completate cu locurile alese (cele lipite = un palet lat; se pot face și paleți separați). Fără hartă, locul se scrie de mână sau se lasă gol, și ERP-ul propune locuri libere. Cu locul știut, „Adaugă marfă” pune paletul direct acolo și scoate etichetele; pagina de confirmare apare doar când ceva nu se potrivește — un loc ocupat între timp, unul care nu există, unul scris pe jumătate — și spune pe nume ce. Prețul se poate scrie cu virgulă. Pe telefon fiecare palet e o cartelă.",
   "/stocuri/ct-park/intrare"],

  ["2026-10-30", "Lista de comenzi arată data cerută de client și data confirmată de producție",
   "Două coloane noi în Comenzi: „Data solicitată” (termenul cerut de client, de pe comandă) și „Confirmată de producție”. Data confirmată e cea de azi a producției: data de livrare din comanda de producție legată, pe care producția o mută când reprogramează — nu ziua în care a confirmat. Dacă o comandă are mai multe comenzi de producție, se vede cea mai târzie, fiindcă atunci e gata toată. O dată confirmată după cea cerută de client iese pe roșu. Unde nu e încă o dată, scrie de ce: „așteaptă producția”, „refuzată de producție” sau „în producție, fără dată”.",
   "/comenzi"],

  ["2026-10-29", "Catalog prețuri pentru agenți, în Vânzări",
   "Ofertele de la furnizori, pe aceleași categorii, cu aceeași căutare și aceleași filtre ca în Procurement — dar cu prețul de vânzare (+25% peste oferta furnizorului) și fără nimic de modificat. Pe fiecare rând, butonul „Copiază” pune în clipboard articolul, specificația, prețul, cantitatea minimă și valabilitatea, gata de lipit într-o ofertă către client. Furnizorul nu apare deloc: nici coloană, nici filtru, nici în textul copiat. Pagina e făcută din același cod cu cea de la Procurement, deci o categorie sau o ofertă nouă apare în amândouă deodată. Tot acum, în Procurement se vede și specificația articolului sub nume — codul o cerea, dar n-o citea din bază.",
   "/crm/catalog-preturi"],

  ["2026-10-29", "Costul marfă din rețete e doar marfă: fără salarii, transport, energie și fără rețetele scrise pe lot",
   "Rapoartele de producție din SmartBill pun pe fiecare lot, lângă materia primă, și salariile, transportul și energia — corect pentru contabilitate, dar puntea le aducea în rețetă ca pe niște componente, deci intrau în „costul marfă”. Acum liniile astea rămân scrise în rețetă, într-o secțiune separată („Costuri ale firmei”), dar nu se mai adună la cost, nu se numără „fără cost” și nu se mai cer din depozit la necesarul de materie primă. Recunoașterea e strictă: „Folie stretch transport palet” e folie și rămâne în cost. Al doilea lucru: cardul „Cost marfă, comenzi deschise” din Producție nu mai adună comenzile a căror rețetă pare scrisă pe lot (cost pe bucată de peste trei ori prețul de vânzare). O singură rețetă, a plicurilor AWB, era scrisă pe lot — peste 40 m² de hârtie „pe un plic” — și, înmulțită cu 700.000 de plicuri, dădea 23,6 milioane din cele 23,75 de pe card. Comenzile lăsate deoparte apar sub carduri, cu link spre rețetă; pagina comenzii și necesarul spun același lucru. După reparat rețeta, comanda intră singură în total.",
   "/productie"],

  ["2026-10-29", "Factura pleacă în SmartBill cu țara, județul și localitatea clientului",
   "FCT-1 a fost refuzată de SmartBill: „țara trebuie specificată”. Fișa clientului avea doar adresa, ca un singur text. Acum are și localitate, județ și țară. La clienții importați din SmartBill ele se citesc din adresă („…, Loc.Dobridor, Jud. Dolj, Tara Romania”) și factura pleacă direct; unde adresa nu spune limpede — client fără adresă, adresă scrisă de mână, client străin —, ERP-ul le cere o singură dată, într-un formular, și le ține în fișă. Nimic ghicit nu ajunge pe factură fără să-l vadă cineva. Tot acum: factura pleacă în moneda ei (una în euro ar fi plecat în lei, cu sumele în euro) și cu unitatea de măsură a produsului, nu „buc” pe orice linie.",
   "/parteneri"],

  ["2026-10-29", "Prețul din comandă primește orice preț — și virgula",
   "O linie cu prețul 0.16005859375 făcea ca 0,16 să fie refuzat la modificare: câmpul era de tip „număr” cu pas de 0,0001, iar browserul numără pasul de la valoarea cu care pornește câmpul, deci singurele prețuri „valide” erau cele care difereau de 0.16005859375 cu câte 0,0001. Acum câmpul primește orice preț, cu virgulă sau cu punct, și îl arată cu cel mult 4 zecimale. Dacă nu atingi prețul, rămâne exact cel din bază — sub câmp scrie „în bază: …” când are mai multe zecimale decât se văd —, ca formularul să nu schimbe singur bani; ce tastezi se scrie rotunjit la 4 zecimale. „0,16” înseamnă 0,16 lei: înainte, pe un browser în engleză, devenea 16. Un preț care nu e limpede un număr („1.234,56”) e refuzat, cu linia pe care stă. Și tabelul de produse nu mai iese din casetă: formularul e mai lat, iar sub lățimea tabelului rândurile se fac cartele, ca pe telefon.",
   "/comenzi/nou"],

  ["2026-10-28", "Facturile puse pe altă firmă decât a seriei lor se văd și se mută cu un buton",
   "Sincronizarea din SmartBill a citit o vreme firma emitentă din tabelul de clienți, unde stă și „WAREHOUSE ALL SRL”, și a pus facturi Cash Machine pe Warehouse All. Totalurile pe grup au rămas corecte, dar rapoartele pe firmă greșeau exact cu valoarea lor. În Verificări date e acum o secțiune care le arată, cu un buton care le mută pe firma seriei. A cui e o serie nu e scris în cod: se vede din date (firma care ține cel puțin 90% din facturile ei), iar pagina scrie pe ce s-a bazat — „CSHM: 3.128 pe Cash Machine, 4 pe Warehouse All”. O serie împărțită mai egal nu se atinge. Se schimbă doar firma emitentă, nicio sumă; mutarea se poate anula, iar anularea nu calcă o mutare făcută între timp de mână.",
   "/admin/date#serie-alta-firma"],

  ["2026-10-28", "Comenzile au aceeași culoare în orice pagină",
   "Roșu = nouă, neatinsă de nimeni. Albastru = în lucru la noi (confirmată, în producție). Galben = așteaptă ceva din afară (ciornă de validat, așteaptă marfă). Verde = gata (finalizată, în stoc depozit, facturată). Negru = a plecat la client (livrată, livrată parțial). Gri = anulată — era roșie până acum, dar dacă roșu înseamnă și „cere ceva de la tine” și „rând mort”, nu mai înseamnă nimic. Culorile stăteau scrise în trei locuri care nu știau unul de altul — comenzile de vânzare, registrul de producție și selectul de stare din registru — și ajunseseră să nu mai semene, așa că aceeași comandă își schimba culoarea când treceai dintr-o pagină în alta. Acum e un singur tabel, în lib/comenzi-stari.js, pe care îl citesc toate.",
   "/comenzi"],

  ["2026-10-28", "„+ Furnizor nou” pe comanda către furnizor chiar deschide ceva",
   "Butonul dispărea și părea că nu se întâmplă nimic. De fapt formularul se deschidea — dar la 1020 de pixeli, adică sub marginea de jos a ecranului, fiindcă butonul stă sus lângă lista de furnizori iar formularul e ultimul din pagină (două formulare nu se pot imbrica în HTML). Acum pagina derulează la el și intră cu cursorul în „Denumire”. În plus, „Închide” aduce butonul înapoi: până acum, odată închis, nu se mai putea adăuga niciun furnizor fără reîncărcarea paginii. Și scrie pe formular că pozițiile scrise sus se pierd la salvarea furnizorului — se salvează separat, deci pagina se reîncarcă; adaugă întâi furnizorul, apoi scrie ce comanzi.",
   "/procurement/comenzi/noua"],

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
