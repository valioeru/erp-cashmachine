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

## De făcut

### 1. Fluxul comandă → producție → stoc → factură
- Agentul plasează comanda pentru client (din CRM).
- Comanda intră în **Producție** și populează lista de comenzi.
- Cine are acces pe modul îi dă status.
- La statusul **„comandă în stoc depozit"**, agentul poate apăsa
  **Facturează**.
- Se generează o **factură ciornă**.
- Cineva cu drepturi pe **Facturare** o validează.
- La validare: pleacă în **SmartBill** și scade stocul — și în SmartBill,
  și la noi.

### 2. Costul lunar din Drive
- State de plată din `Grup-Oeru` (Drive) → cost lunar la zi pentru fiecare om.
- Mașini: Isabela 1.999,54 / Moinescu 1.849,41 / Cătălin 1.999,54.
- Carburant: cardurile OMV (rezervele) de confirmat pe fiecare agent.

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
