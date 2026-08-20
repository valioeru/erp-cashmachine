# ERP — aplicație online pentru companie

Aplicație web cu autentificare pe roluri și șase module: **Facturare &
contabilitate** (cu integrare SmartBill), **Achiziții**, **Stocuri &
producție** (inclusiv rețete/BOM), **CRM & Comenzi**, **HR & salarizare** și
**Rapoarte**. Rulează online, cu bază de date PostgreSQL (backup automat pe
Render).

## Autentificare și roluri

Aplicația are acum conturi de utilizator (nu mai e liber accesibilă oricui
are link-ul). La prima pornire, dacă nu există niciun utilizator, se
creează automat un cont de **administrator** — email și parolă apar în
logurile serviciului (Render → Logs) la primul start, sau pot fi fixate
dinainte cu variabilele de mediu `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Rolurile disponibile:

- **Administrator** — acces la tot, inclusiv la pagina „Utilizatori” unde
  poate adăuga/dezactiva conturi și schimba roluri.
- **Agent vânzări** — Dashboard, Parteneri, CRM, Comenzi, Produse, Stocuri.
- **Financiar / contabilitate** — Dashboard, Parteneri, Facturare,
  Achiziții, Rapoarte, Angajați, Salarizare.
- **Gestionar depozit** — Dashboard, Produse, Stocuri, Import.

Împărțirea de mai sus e o primă versiune rezonabilă — se poate ajusta ușor
din `lib/auth.js` (`ACCES_ROL`), fără alte modificări.

Fiecare utilizator își poate schimba parola din pagina „Profilul meu”
(link în dreapta sus, lângă nume).

**Notă tehnică**: sesiunile sunt ținute în memorie (nu într-o bază
separată) — la un restart/redeploy al serviciului, toată lumea trebuie să
se autentifice din nou. Comportament acceptabil pentru un tool intern; dacă
devine deranjant, se poate muta sesiunea în baza de date.

## Arhitectură

- **Server**: Node.js simplu (`http` nativ), fără framework — cod ușor de
  citit și modificat.
- **Bază de date**: PostgreSQL, prin pachetul `pg`. Schema (inclusiv
  coloanele/tabelele adăugate ulterior) se creează/actualizează automat la
  fiecare pornire (`lib/db.js`).
- **Găzduire**: Render (web service + PostgreSQL, cu backup pe planurile
  plătite).
- **Integrare SmartBill**: `lib/smartbill.js` — trimite facturi emise către
  SmartBill și poate interoga stocul curent prin API. Vezi secțiunea
  dedicată mai jos pentru limitări.

## Module

- **Parteneri** (`/parteneri`) — clienți și furnizori, cu pagină de detaliu:
  istoricul comenzilor, facturilor, interacțiunilor și oportunităților
  fiecărui partener.
- **CRM** (`/crm`) — pipeline de vânzări (oportunități pe stadii: lead →
  calificat → ofertă → negociere → câștigat/pierdut) și lista de
  follow-up-uri scadente. Interacțiunile (apeluri, emailuri, notițe) se
  adaugă din pagina fiecărui partener.
- **Produse** (`/produse`) — catalog, preț, TVA, stoc minim. Pagina de
  detaliu a unui produs arată stocul pe fiecare depozit/gestiune și
  **rețeta de fabricație (BOM)** — din ce alte produse (materii
  prime/semifabricate) e compus, editabilă direct din interfață.
- **Stocuri** (`/stocuri`) — depozite, intrări/ieșiri, stoc curent calculat
  automat, alertă sub stoc minim.
- **Comenzi** (`/comenzi`) — comenzi de vânzare cu linii de produse, status,
  generare automată a facturii.
- **Facturare** (`/facturi`) — facturi de vânzare, cu TVA, plăți, status
  automat, buton de trimitere în SmartBill.
- **Achiziții** (`/facturi/achizitii`) — facturi primite de la furnizori
  (introduse manual sau importate), cu evidența plăților către furnizori.
- **Rapoarte** (`/rapoarte`) — vânzări vs. achiziții pe ultimele 12 luni
  (grafic simplu), top clienți, top furnizori, facturi restante.
- **HR & salarizare** (`/angajati`, `/salarii`) — angajați și state de
  plată lunare (calcul simplificat, vezi mai jos).
- **Import** (`/import`) — aduce în ERP datele deja existente în SmartBill
  (vezi secțiunea următoare).

Dashboard-ul (`/`) centralizează indicatorii principali.

## Import de date din SmartBill

SmartBill **nu are un API public pentru export în masă** al istoricului
(facturi vechi, listă de parteneri, stocuri pe gestiuni, rețete, bonuri de
consum) — API-ul lor e construit pentru emiterea de documente noi, nu
pentru extragere. Verificat explicit înainte de a construi acest modul.
Soluția practică: exporți rapoartele din contul tău SmartBill (Excel,
sau salvate ca CSV) și le încarci din pagina `/import` — sigur de rulat de
mai multe ori, rândurile deja existente sunt sărite automat.

Tipuri de import disponibile:

1. **Facturi emise / facturi de achiziție** — SmartBill Facturare →
   Rapoarte → Facturi emise → export Excel. Pentru achiziții, echivalentul
   din Gestiune.
2. **Parteneri** — opțional, dacă ai un export separat cu lista de clienți/
   furnizori (parteneri se creează oricum automat din facturi).
3. **Stoc pe gestiuni** — cantități curente per depozit → devin mișcări de
   stoc "intrare" (stoc inițial).
4. **Bonuri de consum intern** — devin mișcări de stoc "ieșire".
5. **Rețete de produs (BOM)** — produs finit + componentă + cantitate.
6. **Sincronizare stoc curent, live** — singurul care chiar apelează
   API-ul SmartBill (`GET /stocks`) în timp real, nu fișier. Structura
   exactă a răspunsului **nu a fost testată** contra unui cont real — la
   primul test, dacă formatul nu se potrivește, pagina arată răspunsul brut
   ca să putem ajusta rapid maparea din `modules/import.js`.

Fiecare tip de import încearcă să recunoască automat coloanele (după
denumire, indiferent de diacritice) — dacă nu recunoaște fișierul, arată
exact ce coloane a găsit, ca să putem ajusta.

**Limitare cunoscută**: exportul standard de facturi din SmartBill are
detaliu doar la nivel de document (client, sumă, TVA, status), nu și
liniile de produse — facturile importate apar cu o singură linie sumar
("conform document X"), nu cu produsele reale. Pentru facturile plătite
parțial, din exportul standard nu reiese suma exactă încasată — apare
statusul corect, dar valoarea "Încasat" de pe dashboard nu include acele
sume până nu se înregistrează plata manual.

## Integrare SmartBill (emitere facturi)

`lib/smartbill.js` conține clientul de integrare pentru trimiterea
facturilor de vânzare emise din ERP către SmartBill. **Important**:
structura exactă a request-ului e construită pe baza tiparului public al
API-ului, dar nu a fost testată împotriva unui cont real — la primul test
din aplicație (butonul "Trimite factura în SmartBill"), dacă apare o eroare
de la SmartBill, ajustăm maparea din `construiesteFactura`.

Variabile de mediu necesare: `SMARTBILL_EMAIL`, `SMARTBILL_TOKEN`,
`SMARTBILL_CIF`, opțional `SMARTBILL_SERIE`. Fără ele, integrarea e
dezactivată automat (aplicația funcționează normal, doar fără trimitere).

## Important — calculul de salarii este orientativ

Modulul de salarizare aplică o formulă simplificată (CAS 25%, CASS 10%,
impozit pe venit 10%) și **nu ține cont** de deduceri personale, facilități
fiscale sectoriale etc. **Verifică sumele cu un contabil înainte de plată.**

## Limitări cunoscute

- **Numerotarea facturilor** e simplă, incrementală — nu garantează
  conformitatea cu cerințele legale de numerotare din România (unul din
  motivele pentru care integrarea SmartBill contează).
- **Rapoarte financiare** — acoperă vânzări/achiziții/restanțe; nu
  înlocuiesc un bilanț contabil complet.
- **Pontaj/concedii** — HR are doar salariul de bază, fără ore lucrate.
- **Sesiuni în memorie** — vezi nota din secțiunea Autentificare.

## Rulare locală (opțional, pentru testare)

Necesită un PostgreSQL local (sau un container Docker):

```bash
docker run --name erp-postgres -e POSTGRES_PASSWORD=parola -e POSTGRES_DB=erp -p 5432:5432 -d postgres:16
cp .env.example .env   # completează DATABASE_URL
npm install
npm start
```

Apoi deschizi `http://localhost:3000` — te loghezi cu contul de admin creat
automat (vezi consola la pornire).

## Structura codului

- `server.js` — pornire server, rutare, healthcheck, verificarea de
  autentificare/rol pe fiecare cerere.
- `lib/db.js` — conexiune PostgreSQL + schema (creată/actualizată automat).
- `lib/auth.js` — parole (hash+salt), sesiuni, roluri și acces pe secțiuni.
- `lib/router.js` — router minimal (fără framework), inclusiv parsare
  multipart/form-data pentru upload de fișiere (fără dependințe externe).
- `lib/crud.js` — generator generic de CRUD pentru entități simple.
- `lib/render.js` — layout HTML, tabele, formatare, navigație filtrată pe
  rol.
- `lib/smartbill.js` — client API SmartBill (emitere facturi + interogare
  stoc).
- `lib/import-utils.js` — parsare CSV/Excel, comună tuturor tipurilor de
  import.
- `modules/*.js` — câte un fișier per modul de business.
- `render.yaml` — configurare deploy Render (web service + PostgreSQL).
