# ERP — aplicație online pentru companie

Aplicație web cu patru module: **Facturare & contabilitate** (cu integrare
SmartBill), **Stocuri & inventar**, **Vânzări & CRM** și **HR &
salarizare**. Rulează online, cu bază de date PostgreSQL (backup automat pe
Render) — nu mai depinde de un fișier local.

## Arhitectură

- **Server**: Node.js simplu (`http` nativ), fără framework — cod ușor de
  citit și modificat.
- **Bază de date**: PostgreSQL, prin pachetul `pg`. Schema se creează automat
  la pornire (`lib/db.js`).
- **Găzduire**: Render (`render.yaml` — un "Blueprint" care creează automat
  serviciul web + baza de date PostgreSQL legate între ele).
- **Integrare SmartBill**: `lib/smartbill.js` — client pentru API-ul de
  facturare SmartBill (vezi secțiunea dedicată mai jos).

## Deploy pe Render

1. Codul trebuie să fie într-un repo Git (GitHub/GitLab) — dacă nu ai încă
   unul, spune-mi și te ajut să-l creezi.
2. În Render Dashboard: **New → Blueprint**, alegi repo-ul. Render citește
   `render.yaml` și creează automat serviciul web + baza de date, deja
   legate prin `DATABASE_URL`.
3. După primul deploy, mergi în serviciul web → **Environment** și adaugi
   (dacă ai acces API SmartBill): `SMARTBILL_EMAIL`, `SMARTBILL_TOKEN`,
   `SMARTBILL_CIF`, `SMARTBILL_SERIE`.
4. Aplicația pornește automat, creează schema bazei de date și inserează
   date demonstrative dacă baza e goală.

Dacă ai conectat conectorul Render în Claude, pot face pașii 1-3 direct,
fără să treci prin dashboard.

## Rulare locală (opțional, pentru testare)

Necesită un PostgreSQL local (sau un container Docker):

```bash
docker run --name erp-postgres -e POSTGRES_PASSWORD=parola -e POSTGRES_DB=erp -p 5432:5432 -d postgres:16
cp .env.example .env   # completează DATABASE_URL
npm install
npm start
```

Apoi deschizi `http://localhost:3000`.

## Module

- **Parteneri** (`/parteneri`) — clienți și furnizori.
- **Produse** (`/produse`) — catalog, preț, TVA, stoc minim.
- **Stocuri** (`/stocuri`) — depozite, intrări/ieșiri, stoc curent calculat automat, alertă sub stoc minim.
- **Vânzări / CRM** (`/comenzi`) — comenzi cu linii de produse, status, generare automată a facturii.
- **Facturare & contabilitate** (`/facturi`) — facturi cu TVA, plăți, status automat (emisă → plătită parțial → plătită), buton de trimitere în SmartBill.
- **HR & salarizare** (`/angajati`, `/salarii`) — angajați și state de plată lunare (calcul simplificat de taxe, vezi mai jos).

Dashboard-ul (`/`) centralizează indicatorii principali.

## Integrare SmartBill

`lib/smartbill.js` conține clientul de integrare. **Important**: structura
exactă a request-ului (`construiesteFactura`) e construită pe baza
tiparului public al API-ului SmartBill (autentificare Basic Auth cu
emailul contului + un token API, endpoint `POST /invoice`), dar **nu a
fost testată împotriva unui cont real** — documentația tehnică completă se
obține abia după ce SmartBill aprobă cererea de API. La primul test din
aplicație (butonul "Trimite factura în SmartBill" de pe pagina unei
facturi), dacă SmartBill respinge request-ul cu o eroare de câmp, ajustăm
maparea din `construiesteFactura` pe loc.

Pași necesari din partea ta:

1. Confirmă că ai abonamentele **Facturare Platinum** și **Gestiune Plus**.
2. Trimite un email către **vreauapi@smartbill.ro** cerând acces API.
3. Adaugă în variabilele de mediu ale serviciului (Render → Environment):
   `SMARTBILL_EMAIL` (emailul contului), `SMARTBILL_TOKEN` (token-ul primit),
   `SMARTBILL_CIF` (CIF-ul firmei tale), `SMARTBILL_SERIE` (seria de facturi
   dorită, opțional).

Fără aceste variabile, butonul de trimitere e dezactivat automat (aplicația
funcționează normal, doar fără integrare).

## Important — calculul de salarii este orientativ

Modulul de salarizare aplică o formulă simplificată (CAS 25%, CASS 10%,
impozit pe venit 10%) și **nu ține cont** de deduceri personale, facilități
fiscale sectoriale etc. **Verifică sumele cu un contabil înainte de plată.**

## Limitări cunoscute

- **Fără autentificare** — oricine are link-ul poate vedea/modifica datele.
  Pe Render, poți restricționa accesul prin autentificare de bază (îți pot
  adăuga login) înainte să dai linkul echipei.
- **Numerotarea facturilor** e simplă, incrementală — nu garantează
  conformitatea cu cerințele legale de numerotare din România (asta e unul
  din motivele pentru care integrarea SmartBill contează — SmartBill
  gestionează corect acest aspect).
- **Rapoarte financiare complete** — momentan doar evidența facturilor/plăților.
- **Pontaj/concedii** — HR are doar salariul de bază, fără ore lucrate.

## Structura codului

- `server.js` — pornire server, rutare, healthcheck.
- `lib/db.js` — conexiune PostgreSQL + schema.
- `lib/router.js` — router minimal (fără framework).
- `lib/crud.js` — generator generic de CRUD pentru entități simple.
- `lib/render.js` — layout HTML, tabele, formatare.
- `lib/smartbill.js` — client API SmartBill.
- `modules/*.js` — câte un fișier per modul de business.
- `render.yaml` — configurare deploy Render (web service + PostgreSQL).
