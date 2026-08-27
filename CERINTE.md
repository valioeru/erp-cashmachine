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

## De făcut

### 1. Ce mai lipsește la cost company
- **Carburantul OMV** — singurul lucru care lipsește din cost company. Cere
  login-ul lui Vali (nu introduc parole) și permisiune pentru extensie pe
  `fleet.omv.com`.
- Statele de plată se citesc azi manual, din Drive, și ajung în ERP prin
  `date/costuri-agenti.json`. Conectorul Google Drive NU vede folderul
  Grup-Oeru (e partajat, nu deținut de contul cashmachine.ro), deci drumul
  rămâne browserul.

### 2. Restul detaliului pe produse
- Din cele 594 de facturi pe 2026 s-a importat detaliul pentru primele ~100,
  de la cele mai noi spre vechi. Restul se pot lua rulând din nou puntea —
  ritmul e ~5 facturi/minut, limitat de cât durează randarea paginii SmartBill.
- Top-vânzătorii lunii curente încă apar cu cost 0: produsele potrivite pe
  linia de factură n-au preț de achiziție nici din stoc, nici din rețetă.
  Probabil sunt rânduri duplicate de produs — de verificat în nomenclator.

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
