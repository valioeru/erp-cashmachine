# ERP — aplicație online pentru Cash Machine

Aplicație web multi-utilizator, cu autentificare pe roluri: **Facturare &
contabilitate** (cu integrare SmartBill), **Achiziții**, **Stocuri &
producție** (inclusiv rețete/BOM), **CRM** (lead-uri, pipeline, task-uri,
emailuri), **Task-uri**, **Rapoarte** (financiare / operaționale /
comerciale) și **HR & salarizare**. Rulează online, pe PostgreSQL (Render).

## Autentificare și roluri

La prima pornire, dacă nu există niciun utilizator, se creează automat un cont
de **administrator** — emailul și parola apar în logurile serviciului (Render →
Logs) la primul start, sau pot fi fixate dinainte cu variabilele de mediu
`ADMIN_EMAIL` / `ADMIN_PASSWORD`.

| Rol | Ce vede |
|---|---|
| **Administrator** | Tot, inclusiv pagina „Utilizatori” (adaugă/dezactivează conturi, schimbă roluri). |
| **Agent vânzări** | Dashboard, Parteneri, CRM, Task-uri, Comenzi, Produse, Stocuri, rapoartele comerciale, Profilul meu. |
| **Financiar / contabilitate** | Dashboard, Parteneri, Facturare, Achiziții, toate Rapoartele, Task-uri, Angajați, Salarizare. |
| **Gestionar depozit** | Dashboard, Produse, Stocuri, Comenzi, Import, Task-uri, rapoartele operaționale. |

Împărțirea se ajustează dintr-un singur loc: `ACCES_ROL` în `lib/auth.js`.

Fiecare utilizator își schimbă parola din „Profilul meu” și își configurează
contul de email din „Profilul meu → Email”.

**Notă**: sesiunile sunt ținute în memorie — la un restart/redeploy toată lumea
se autentifică din nou. Acceptabil pentru un tool intern; se poate muta în baza
de date dacă devine deranjant.

## Module

- **Parteneri** (`/parteneri`) — clienți și furnizori. Pagina fiecărui partener
  arată comenzile, facturile (ambele sensuri), oportunitățile, **task-urile**,
  **emailurile trimise** și istoricul de interacțiuni, cu butoane rapide de
  „Trimite email” și „+ Task”.
- **CRM** (`/crm`) — trei componente legate:
  - **Pipeline** — oportunități pe stadii (lead → calificat → ofertă →
    negociere → câștigat/pierdut), fiecare cu agent responsabil.
  - **Lead-uri** (`/crm/leaduri`) — contacte care încă *nu* sunt clienți, ținute
    separat ca lista de parteneri să nu se umple de contacte necalificate. Au
    sursă, scor, stadiu, agent, istoric de interacțiuni și **conversie într-un
    pas** în client (+ opțional oportunitate). Task-urile lead-ului se mută
    automat pe partenerul nou creat.
  - **Activitate & emailuri** (`/crm/activitate`) — tot ce s-a trimis și
    discutat, într-un singur loc.
- **Task-uri** (`/taskuri`) — sarcini atribuibile **oricărui utilizator**, cu
  tip, prioritate, scadență, comentarii și legătură cu orice entitate din ERP
  (partener, lead, oportunitate, comandă, factură). Lista arată separat
  task-urile depășite și încărcarea fiecărui coleg.
- **Produse** (`/produse`) — catalog, preț, TVA, stoc minim; pagina de detaliu
  arată stocul pe fiecare gestiune și **rețeta de fabricație (BOM)**.
- **Stocuri** (`/stocuri`) — depozite, intrări/ieșiri, stoc curent, alertă sub
  stocul minim.
- **Comenzi** (`/comenzi`) — comenzi de vânzare cu linii de produse, status,
  generare automată a facturii.
- **Facturare** (`/facturi`) și **Achiziții** (`/facturi/achizitii`) — cu
  căutare, filtrare pe status și paginare (necesare la un istoric de mii de
  documente), plăți și buton de trimitere în SmartBill.
- **Rapoarte** (`/rapoarte`) — vezi mai jos.
- **HR & salarizare** — angajați și state de plată lunare (calcul simplificat).
- **Import** (`/import`) — aduce în ERP datele existente în SmartBill.

## Rapoarte

Grupate pe categorii, fiecare la propriul URL:

**Financiare**

- **Scadențar încasări** (`/rapoarte/incasari`) — cât ai de încasat **în fiecare
  zi**, după scadența facturii, cu bară proporțională pe zi. Statusul se schimbă
  direct din listă (marchează achitat, amână scadența cu 30 de zile, anulează
  documentul) și se poate seta scadența acolo unde lipsește din exportul
  SmartBill. Funcționează și invers, pentru plățile către furnizori.
  „Depășit” **nu** e un status stocat, ci se calculează din scadență față de
  ziua curentă — așa nu poate rămâne niciodată nesincronizat.
- **Restanțe & vechime** (`/rapoarte/restante`) — aging pe intervale
  (nescadent, 1–30, 31–60, 61–90, peste 90 de zile), parteneri cu cele mai mari
  solduri, documente cu cea mai veche întârziere.
- **Vânzări vs. achiziții** (`/rapoarte/vanzari`) — evoluție pe 6/12/24/36 de luni.
- **Top clienți & furnizori** (`/rapoarte/parteneri`) — cu procent din total.

**Operaționale**

- **Situația stocurilor** (`/rapoarte/stocuri`) — stoc pe produs și pe gestiune,
  valoare la preț de achiziție, produse sub minim.
- **Comenzi pe status** (`/rapoarte/comenzi`) — inclusiv cele mai vechi comenzi
  nefinalizate.

**Comerciale**

- **Pipeline oportunități** (`/rapoarte/pipeline`).
- **Forecast vânzări** (`/rapoarte/forecast`) — proiecție pe 3–12 luni:
  sezonalitatea reală (media aceleiași luni din ultimii ani) × trendul an/an,
  cu bandă pesimist/optimist din volatilitatea reală a lunilor, luna în curs
  proiectată din ritmul zilnic, plus pipeline-ul CRM ponderat pe stadii.
- **Clienți activi & inactivi** (`/rapoarte/clienti`) — cine n-a mai cumpărat de
  peste 90/180/365/730 de zile, ordonat după valoarea istorică.

## Agenți de vânzări și portofolii de clienți

Fiecare client are un **agent responsabil**. Alocarea vine automat la import:
numele agentului scris în câmpul Observații al facturii din SmartBill (ex.
„isabela radu" pe CSHMUPA0037) devine agentul clientului — dacă utilizatorul
nu există, se creează automat cont de agent de vânzări (adminul îi setează
parola din „Utilizatori"). Clienții fără agent în observații rămân alocați
administratorului. **Doar administratorul** poate schimba agentul unui client
(din pagina clientului), iar agenții **nu pot șterge** clienți sau alte date
(orice ștergere e blocată pe server pentru non-admini).

**Biroul meu** (`/crm/birou`) — dashboardul personal al fiecărui agent:
portofoliul lui cu vânzări pe 12 luni și solduri, pipeline-ul lui, calendarul
task-urilor pe următoarele 14 zile, remindere pentru task-urile întârziate,
zilele de naștere ale clienților (cu urare precompletată, trimisă pe emailul
lui) și sugestii: clienți de reactivat (fără cumpărături de 90+ zile) și
clienți fără agent dedicat, de preluat în portofoliu. Adminul poate deschide
biroul oricărui agent.

**Profitabilitate pe agent & client** (`/rapoarte/agenti`) — venit net, marjă
(doar unde există costuri de produs — facturile importate din SmartBill n-au
detaliu pe produse, iar raportul spune explicit cât din venit are cost
cunoscut), pipeline deschis și solduri pe fiecare agent, cu detaliu pe
clienții lui. Pipeline-ul din `/crm` se poate filtra pe un singur agent
(admin); agenții își văd doar propriul pipeline.

Toate tabelele din aplicație se **sortează la click pe antet** (numere în
format românesc, date și text, cu săgeată de direcție).

## Balanța de verificare

`/rapoarte/balanta` — balanță contabilă reală, pe planul de conturi românesc
(OMFP 1802/2014), cu cele patru serii de coloane: solduri inițiale, rulaje,
total sume, solduri finale, pe orice perioadă sau zi. Documentele ERP
(facturi, încasări, plăți, salarii) se traduc automat în note contabile
(4111 = 707 + 4427, 5121 = 4111, 371/4426 = 401 etc.), regenerate integral la
fiecare schimbare — deci balanța e mereu la zi. Cele patru egalități se
verifică la fiecare afișare, iar din fiecare cont se deschide **fișa contului**
cu sold rulant.

SmartBill **nu are API pentru Conta** (verificat — API-ul acoperă doar
Facturare), deci soldurile de deschidere se preiau din balanța exportată din
SmartBill Conta (XLS/CSV) în pagina „Solduri inițiale" — o singură dată, de
regulă la început de an; de acolo încolo ERP-ul mișcă singur soldurile.
Notele introduse manual și soldurile inițiale nu se ating la regenerare.
Amortizările, provizioanele și închiderile de lună rămân operațiuni de
contabil.

## Producție — comenzi în lucru

`/productie` — fluxul care era ținut în Excelul „Comenzi_in_lucru": agentul
inițiază comanda cu data SOLICITATĂ de client, producția răspunde cu data
PROPUSĂ și pornește lucrul; statusul curge nouă → în producție → finalizată →
facturată. Importul din Excelul istoric recunoaște statusurile oriunde ar fi
pe rând (done/facturat/canceled „plutesc" între coloane în fișierul real),
datele în ambele formate (19.09.2025 și 09/23/2025 — punct = românesc,
slash = american) și sare dublurile. Comenzile fără status se deduc: vechi →
finalizate, recente → în producție. De la import încolo, comenzile se
introduc direct din aplicație.

## Bancă — extras de cont & reconciliere

`/banca` — imporți extrasul de cont (CSV din internet banking; coloanele se
recunosc automat, inclusiv formatul debit/credit al băncilor românești), iar
aplicația potrivește automat tranzacțiile cu facturile: sumă exactă + numele
partenerului sau numărul documentului în descriere. Potrivirile sigure se
propun; nimic nu devine plată fără confirmare (individuală sau „confirmă
toate"). Tranzacțiile rămase se leagă manual dintr-o listă de candidați.
Reimportul extraselor suprapuse e sigur (amprentă pe dată+sumă+descriere).
Conectarea directă la bancă (fără export) e posibilă doar printr-un agregator
licențiat PSD2 (GoCardless Bank Account Data, Smart Fintech etc.) — se poate
integra ulterior.

## Rapoarte pentru bancă și comparații

- **Indicatori financiari — ochii băncii** (`/rapoarte/indicatori`): DSO,
  DPO, restanțe, concentrarea clienților, trend an/an — fiecare cu ținta
  băncii și starea lui — plus estimarea sumei finanțabile (linie de credit
  8–12% din cifră; factoring 80% din creanțele nedepășite) și sugestii
  concrete de îmbunătățire a punctajului, generate din datele reale.
- **Comparație la zi** (`/rapoarte/comparatie`): 1 ianuarie → azi, anul
  curent vs. ultimii doi ani — vânzări, încasări, costuri, facturi, clienți
  activi, valoarea medie a facturii, plus graficul lunar suprapus pe 3 ani.
- **Plăți furnizori pe zile** — scadențarul pe direcția „plăți către
  furnizori", cu totaluri pe zi și pe furnizor, pe săptămâna în curs sau
  orice altă perioadă.

## Balanțe din SmartBill Conta: ancoră + istoric

Două utilizări, ambele pe formatul real de export (antet pe două rânduri,
„Perioada: dd/mm/yyyy - dd/mm/yyyy"):

- **Solduri inițiale** — balanța ultimei luni închise devine ancora: toate
  soldurile pornesc din cifrele contabilului (bancă, capital, credite,
  furnizori…), iar din ziua următoare ERP-ul le mișcă singur. Facturile
  istorice deja importate sunt EXCLUSE automat din calcule până la ancoră —
  altfel s-ar număra dublu (o dată în sold, o dată ca rulaj). NU e nevoie de
  balanțe pe fiecare lună: soldurile finale cumulează tot; reîncarci doar
  când contabilul mai închide o lună, ca să reancorezi.
- **Balanțe istorice** (anuale) — alimentează indicatorii de bilanț reali din
  raportul „Indicatori financiari": capitaluri proprii, lichiditate, grad de
  îndatorare, profit (sold 121), cifră de afaceri (rulaj creditor 70x — cel
  debitor conține închiderile lunare prin 121 și ar da zero), cu evoluția pe
  ani. Verificat pe balanțele reale 2023–2026.

## Cash flow la zi + forecast manual

`/rapoarte/cashflow` — cash disponibil azi (din soldurile ancorate + mișcările
ERP), proiecție zi cu zi pe 14–120 de zile din scadențele facturilor deschise
(restanțele se pun pe „azi" — sunt exigibile acum), cu alertă pe prima zi în
care soldul proiectat scade sub zero. Peste facturi se adaugă manual orice nu
e în sistem: chirii, rate, salarii, taxe, încasări promise — inclusiv
recurente lunar. Istoricul lunar încasări vs. plăți, dedesubt.

## Filtre de perioadă și excluderi din top

Rapoartele cu perioadă au preseturi comune: ultimele 3/6/12/24 de luni, anul
curent, anul trecut, tot istoricul sau o perioadă custom aleasă manual. În
Top clienți & furnizori, orice partener se poate elimina din vizualizare cu
un click (procentele se recalculează fără el) — excluderea trăiește doar în
URL, la o nouă deschidere a raportului reapar toți.

## TVA de plată, la zi

`/rapoarte/tva` — TVA colectată minus TVA deductibilă, pe orice perioadă, cu
defalcare pe luni și cu suma lunii precedente (cea scadentă pe 25). Cumulatul
„la zi" apare după preluarea soldurilor inițiale din balanța Conta — fără
ele, aplicația refuză intenționat să afișeze un cumulat care ar aduna tot
istoricul ca și cum TVA-ul n-ar fi fost plătit niciodată. Calcul informativ —
decontul oficial (D300) rămâne la contabil; la TVA la încasare cifra diferă.

## Emailuri din CRM

Fiecare agent își conectează **propriul cont de email** din „Profilul meu →
Email” (server SMTP, port, criptare STARTTLS sau TLS direct, utilizator,
parolă, semnătură). Emailurile trimise din CRM pleacă de la adresa lui, ca
răspunsul clientului să ajungă direct la el, nu într-o căsuță comună.

Detalii tehnice:

- Clientul SMTP e scris pe modulele native Node (`net`, `tls`) — fără nicio
  dependință externă. Suportă STARTTLS și TLS direct, AUTH LOGIN și AUTH PLAIN,
  subiecte cu diacritice (RFC 2047) și corp UTF-8 (base64).
- **Parola e cifrată** (AES-256-GCM) înainte de a fi salvată. Cheia se derivă
  din variabila de mediu `APP_SECRET` — **setează-o pe Render**; fără ea se
  folosește `DATABASE_URL` ca sursă de secret, ceea ce e mai slab.
- Dacă serverul nu acceptă criptare, trimiterea e **refuzată intenționat**, ca
  parola să nu circule în clar.
- Emailurile se salvează în istoric și când eșuează, cu motivul exact —
  altfel n-ai cum să afli de ce n-a ajuns mesajul la client.
- Pentru Gmail / Microsoft 365 cu 2FA e nevoie de o **parolă de aplicație**, nu
  de parola contului (aplicația afișează nota potrivită automat).

## Import de date din SmartBill

SmartBill **nu are API public pentru export în masă** al istoricului (facturi
vechi, listă de parteneri, stocuri pe gestiuni, rețete, bonuri de consum) —
API-ul lor e construit pentru emiterea de documente noi. Verificat explicit
înainte de a construi acest modul. Soluția: exporți rapoartele din contul tău
SmartBill și le încarci din pagina `/import`. Importul e **idempotent** — poate
fi rulat de mai multe ori, rândurile deja existente sunt sărite.

Tipuri disponibile: facturi emise, facturi de achiziție, parteneri, stoc pe
gestiuni, bonuri de consum intern, rețete de produs (BOM), plus sincronizare
live a stocului curent prin singurul endpoint API care chiar există
(`GET /stocks`).

Ce știe importul de facturi să facă singur, pe exportul real SmartBill:

- **Sare rândurile de titlu.** Exportul începe cu „Facturi incepand din data
  de … pana in data de …”, o notă și un rând gol; header-ul real e abia pe
  rândul 4. Detectarea se face după conținut, nu după poziție.
- **Desparte seria de număr** dintr-o singură coloană (`CSHMUPA0037` → seria
  `CSHMUPA`, numărul 37), păstrând documentul original ca referință.
- **Ignoră rândurile de total** de la finalul raportului (fără client și fără
  număr de document), fără să le raporteze ca erori.
- **Convertește valuta.** Facturile în EUR/USD se stochează în RON, folosind
  cursul implicit din raport (raportul dintre coloana în RON și cea în valută),
  păstrând separat moneda și valoarea originală.
- **Reconstituie cota de TVA** din raportul TVA/net cu 4 zecimale, nu rotunjită
  la întreg — o factură cu linii pe cote diferite (19% + 5%) dă un raport
  intermediar, iar rotunjirea ar strica totalul.
- **Populează automat lista de parteneri** din facturi (nume, CUI, adresă), fără
  dubluri: potrivirea se face întâi pe CUI, apoi pe denumire.
- **Preia indexul SPV** (e-Factura) acolo unde există.

Verificat pe exportul real: 3.033 de facturi din 2016 până azi, 399 de parteneri
noi, 0 erori, iar totalul reconstituit în ERP diferă de totalul raportat de
SmartBill cu 0,24 lei din 115,9 milioane (rotunjiri de bani).

Importul se face **în loturi** (batch insert), nu rând cu rând: la mii de
facturi, varianta rând-cu-rând ar însemna peste 12.000 de interogări și minute
de așteptare, cu risc de timeout. Așa durează sub o secundă.

**Limitare cunoscută**: exportul standard de facturi are detaliu doar la nivel
de document (client, sumă, TVA, status), nu și liniile de produse — facturile
importate apar cu o singură linie sumar, nu cu produsele reale. Pentru
facturile plătite parțial, exportul nu spune suma exactă încasată.

## Integrare SmartBill (emitere facturi)

`lib/smartbill.js` trimite facturile de vânzare emise din ERP către SmartBill.
Structura request-ului e construită pe tiparul public al API-ului, dar **nu a
fost testată împotriva unui cont real** — la primul test (butonul „Trimite
factura în SmartBill”), dacă apare o eroare, ajustăm maparea.

Variabile de mediu: `SMARTBILL_EMAIL`, `SMARTBILL_TOKEN`, `SMARTBILL_CIF`,
opțional `SMARTBILL_SERIE`. Fără ele integrarea e dezactivată automat.

## Variabile de mediu

| Variabilă | Rol |
|---|---|
| `DATABASE_URL` | **Obligatorie.** Conexiunea PostgreSQL (Render o setează automat). |
| `APP_SECRET` | **Recomandată.** Cheia de cifrare a parolelor de email. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Opțional — fixează contul de admin creat la prima pornire. |
| `SMARTBILL_*` | Opțional — integrarea SmartBill. |

## Important — calculul de salarii este orientativ

Modulul de salarizare aplică o formulă simplificată (CAS 25%, CASS 10%, impozit
10%) și **nu ține cont** de deduceri personale sau facilități sectoriale.
**Verifică sumele cu un contabil înainte de plată.**

## Limitări cunoscute

- **Numerotarea facturilor** e incrementală simplă — nu garantează
  conformitatea cu cerințele legale de numerotare din România (unul din
  motivele pentru care integrarea SmartBill contează).
- **Rapoarte financiare** — acoperă vânzări/achiziții/încasări/restanțe; nu
  înlocuiesc un bilanț contabil.
- **Pontaj/concedii** — HR are doar salariul de bază, fără ore lucrate.
- **Sesiuni în memorie** — vezi nota de la Autentificare.
- **Facturi fără scadență** — 158 din exportul real n-au scadență completată în
  SmartBill; apar grupate la finalul scadențarului, unde li se poate seta data.

## Rulare locală (opțional)

```bash
docker run --name erp-postgres -e POSTGRES_PASSWORD=parola -e POSTGRES_DB=erp -p 5432:5432 -d postgres:16
cp .env.example .env   # completează DATABASE_URL
npm install
npm start
```

## Structura codului

- `server.js` — pornire, rutare, healthcheck, verificarea de autentificare/rol.
- `lib/db.js` — conexiune PostgreSQL + schema (creată/actualizată automat la
  fiecare pornire, inclusiv coloanele adăugate ulterior).
- `lib/auth.js` — parole (scrypt + salt), sesiuni, roluri și acces pe secțiuni.
- `lib/mail.js` — client SMTP propriu + cifrarea parolelor de email.
- `lib/router.js` — router minimal, inclusiv parsare `multipart/form-data`.
- `lib/crud.js` — generator generic de CRUD.
- `lib/render.js` — layout HTML, tabele, formatare, navigație filtrată pe rol.
- `lib/smartbill.js` — client API SmartBill.
- `lib/import-utils.js` — parsare CSV/Excel + detectarea rândului de header.
- `modules/*.js` — câte un fișier per modul de business.
- `render.yaml` — configurare deploy Render.
