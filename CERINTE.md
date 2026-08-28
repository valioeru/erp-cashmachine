# Cerințe în lucru — ERP Cash Machine

Lista asta e ordinea în care se construiește. Ce e bifat e în producție.

## Făcute

- [x] Import încasări reale din SmartBill (data plății, nu data facturii)
- [x] Cititor nativ `.xls` (BIFF8) — exporturile SmartBill se încarcă direct
- [x] Alocare client → agent, cu procent (70/30 etc.)
- [x] Agent pe **factură**, cu domeniu de aplicare la schimbare:
      doar factura / tot istoricul clientului / de la o dată încolo
- [x] Facturile vechi primesc retroactiv agentul curent al clientului;
      restul merg pe administrator
- [x] Perioadă selectabilă în biroul agentului (lună / an / interval)
- [x] Marjă netă, % din vânzările firmei, top clienți, top produse,
      marja pe fiecare vânzare
- [x] Cost company vizibil agentului, editabil doar de admin
- [x] Import state de salarii + alimentări OMV; mașina și cardul pe utilizator
- [x] **Puntea de import** (`/import/punte` + `POST /api/ingest`):
      browserul citește paginile SmartBill și trimite rândurile direct în ERP.
      Rezolvă tot ce nu se poate exporta: rețete din rapoartele de producție,
      bonuri de consum, stoc, produse.
- [x] Agentul își revendică singur clienții, o singură dată (`/crm/alocare`);
      după aceea doar adminul schimbă
- [x] **Oferte cu versionare** (`/oferte`): fiecare revizie e o versiune nouă,
      cea veche rămâne „înlocuită". La acceptare se nasc automat contract
      și/sau comandă, dar din orice pas se poate sări direct la oricare.
- [x] **Contracte** (`/contracte`), din ofertă sau direct; comanda pe contract
      pornește cu liniile ofertei.
- [x] **Task „contactează clientul", generat automat** pentru fiecare agent,
      pe clienții cu care nu s-a mai vorbit de 45 de zile. Se închide cu
      răspuns predefinit — telefon / vizită / email / WhatsApp — plus rezultat
      și detalii; totul intră în istoricul clientului. „Revin pe X" creează
      singur task-ul următor.
- [x] **Vizite cu feedback** — vizita e un mod de contact, cu rezultat și text
      liber, în același istoric ca emailurile.
- [x] **Sugestii de clienți noi** în dashboard, aceeași listă pentru toți
      agenții: clienți fără agent sau adormiți de peste 9 luni. Cine îi ia
      primul îi primește, cu persoană și mod de contact; clientul i se alocă
      și primește imediat un task de contact.
- [x] **Scadențar cu notificări** (`/scadente`, plus bloc în biroul agentului):
      semafor verde/galben/roșu, notificare automată zilnică sau manuală,
      email autogenerat care se înăsprește cu vechimea restanței, preaviz
      politicos la ≤ 3 zile de scadență, comenzi blocate pe clienții roșii,
      regim automat obligatoriu peste 3 luni de restanță (doar adminul îl
      poate opri, din fișa clientului).

- [x] **Meniu**: oferte, contracte, scadențe și alocări au ieșit din bara
      principală și stau sub CRM.
- [x] **Parteneri** ordonați după rulajul din ultimele 12 luni, cu filtru
      clienți / furnizori / toți și căutare după nume sau CUI. Pe fișa
      clientului: semaforul de încasări și comanda adminului de a tăia
      notificările.
- [x] **Dashboard nou**: facturat de la 1 ianuarie până azi vs aceeași
      fereastră din ultimii 3 ani (diferență în lei și în procente), profit
      sau pierdere la zi cu grafic lunar, task-uri, ce e programat (calendar
      + task-urile programate la Claude) și știri relevante pentru business.
- [x] **Fluxul comandă → producție → stoc → factură**: comanda agentului intră
      singură în Producție; la „finalizată" comanda de vânzare trece în „în
      stoc depozit" și abia atunci agentul poate apăsa Facturează; iese o
      factură ciornă (fără număr, fără stoc mișcat, fără SmartBill); cine are
      drepturi pe facturare o validează, și atunci primește număr, scade
      stocul și pleacă în SmartBill.
- [x] **Cost company** pentru agenți, din statele de plată din Drive
      (`date/costuri-agenti.json`) + costul mașinii.
- [x] **Detaliu pe produse la facturi**, citit din SmartBill prin punte
      (`tip: facturi_linii`), cu validare aritmetică pe fiecare linie.
- [x] **Cost pe produs**: din evaluarea stocului SmartBill și, pentru
      produsele fabricate, din rețetă.

- [x] **Meniu restructurat**: nouă zone în loc de șaisprezece — Warehouse
      (comenzi deschise, stocuri, depozite, aprovizionare, achiziții),
      Financiar (bancă, angajați, salarizare, cost company, import) și CRM
      (cu comenzi, produse, calculator de preț).
- [x] **Fluxul nou de comenzi**: comanda intră în depozit, se potrivește cu
      stocul linie cu linie, se confirmă / se rezervă 24 h / se cere
      aprovizionare de la terț sau din producție. Producția confirmă sau
      refuză termenul cerut de agent; la confirmare comanda de producție se
      deschide singură. Agentul alege apoi: facturează tot, facturează parțial
      ce e în stoc, sau așteaptă comanda completă. Producția cere la rândul ei
      materie primă de la depozit, cu același drum invers.
- [x] **Pâlnia de vânzări desenată**, o bandă per stadiu, cu numărul,
      valoarea și conversia scrise în bandă.
- [x] **Dashboard**: al doilea tabel cu cifra de afaceri fără vânzările de
      active (listă de excluderi editabilă) și cu suma anului curent
      corectabilă de mână; al treilea tabel, doar pentru administrator, cu
      profitul contabil din balanțele Conta; „Profit" redenumit EBITDA;
      plus de încasat, clienții care aduc banii, clienții pierduți față de
      anul trecut și ce se vinde.
- [x] **Calculator de preț** pe categorii de produs, cu formule editabile din
      interfață, marjă și trimitere directă în ofertă sau comandă.
- [x] **Angajații din statele de plată din Drive** — 11 oameni, fără CNP-uri.
- [x] **Backup** al întregii baze într-un singur fișier, cu task programat
      noaptea.

## De făcut

### 1. Restul detaliului pe produse din facturi
Din cele 594 de facturi de vânzare pe 2026, 204 au detaliu real pe produse;
**390 mai au doar linia de rezumat** pusă de importul inițial („Conform
document CSHM…"). Puntea își ia coada singură din `/api/facturi-fara-linii`
(CORS deschis doar pentru originile SmartBill, doar cu sesiunea adminului),
iar scriptul stă în `punte/facturi-linii.js`.

**Blocat**: sesiunea din `cloud.smartbill.ro` a expirat. Vali se loghează o
dată acolo și pot rula restul singur — la ~5 facturi/minut, vreo 80 de minute.

### 2. Ce mai lipsește la cost company
- **Carburantul OMV** — singurul lucru care lipsește. Cere login-ul lui Vali
  (nu introduc parole) și permisiune pentru extensie pe `fleet.omv.com`.
- Angajații se iau acum automat din statele de plată (`date/angajati.json`,
  11 oameni). Costul mașinii și carburantul rămân de completat pe fiecare.

### 3. Backup-ul în Drive
Aplicația face backup-ul (`/admin/backup`, 42 de tabele, ~130.000 de rânduri,
2,5 MB gzip). Sesiunea programată din Cowork îl descarcă noaptea la 03:00 în
`C:\Users\PC\Downloads`. **Ca să meargă, Vali trebuie să aprobe o dată
task-ul programat pentru calculatorul lui** — altfel rulează în cloud, unde nu
are nici browser, nici acces la fișierele lui.

Pentru copia în Google Drive: contul din browser (`valentin.oeru@gmail.com`) și
contul conectorului Drive (`valentin.oeru@cashmachine.ro`) sunt diferite, iar
fișierul de 2,5 MB nu poate trece prin conector. Variante: un folder sincronizat
cu Google Drive for desktop (scriu direct în el), sau conectarea contului
gmail.com la Cowork.

### 4. Calculatorul de preț
Formulele implicite (folie stretch, bandă adezivă) sunt puse cu bun-simț, nu cu
cifrele din fabrică. Se schimbă din `/calculator/categorii` — Vali dă cifrele
lui și le înlocuim.

## Blocaje care țin de altcineva

- **OMV**: nu introduc parole. Vali se loghează el și dă permisiune
  extensiei pe `fleet.omv.com`; apoi iau alimentările lunar.
  (Parolele care au circulat prin WhatsApp și chat ar trebui schimbate.)
- **Nume scurte din Registrul de comenzi** (Sameday, Leroy Merlin BR/BV/CT,
  Aquila AR/BV/CT…) — se leagă o dată, din `/alocari/registru`.
- **Emailul de pe care pleacă notificările**: rutina automată folosește contul
  SMTP al primului utilizator care are unul configurat (Profilul meu → Email).
  Până când cineva îl configurează, notificările se înregistrează ca „eșuat",
  cu motivul scris pe ele.
- **Balanțele din Conta**: al treilea tabel de pe dashboard (profitul contabil)
  se completează singur când sunt încărcate balanțele în `/balanta`.
