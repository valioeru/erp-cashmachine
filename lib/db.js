// Strat de acces la baza de date — PostgreSQL (prin pachetul "pg").
// Aplicația rulează online (Render), deci are nevoie de o bază de date
// reală, cu backup, nu de un fișier local. Necesită variabila de mediu
// DATABASE_URL (Render o setează automat quando baza de date e legată de
// serviciul web).
"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "Lipsește variabila de mediu DATABASE_URL. Aplicația are nevoie de o bază de date PostgreSQL " +
      "(pe Render: creează o bază de date și leag-o de serviciul web, se configurează automat)."
  );
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Eroare neașteptată pe conexiunea la baza de date:", err);
});

// Compatibilitate cu stilul "db.prepare(sql).get/.all/.run(...)" folosit în
// restul aplicației, dar asincron (PostgreSQL nu suportă interogări
// sincrone). Placeholder-urile "?" din SQL sunt convertite automat în
// "$1, $2, ..." (sintaxa PostgreSQL).
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPositional(sql);
  return {
    async all(...args) {
      const res = await pool.query(pgSql, args);
      return res.rows;
    },
    async get(...args) {
      const res = await pool.query(pgSql, args);
      return res.rows[0];
    },
    async run(...args) {
      const res = await pool.query(pgSql, args);
      // Dacă interogarea a inclus "RETURNING id", îl expunem ca
      // lastInsertRowid (echivalentul din API-ul better-sqlite3 folosit
      // inițial), ca restul codului să nu trebuiască rescris.
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined,
      };
    },
  };
}

async function exec(sql) {
  await pool.query(sql);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parteneri (
  id SERIAL PRIMARY KEY,
  tip TEXT NOT NULL DEFAULT 'client',
  nume TEXT NOT NULL,
  cui TEXT,
  email TEXT,
  telefon TEXT,
  adresa TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS produse (
  id SERIAL PRIMARY KEY,
  cod TEXT,
  denumire TEXT NOT NULL,
  unitate_masura TEXT DEFAULT 'buc',
  pret_vanzare REAL DEFAULT 0,
  pret_achizitie REAL DEFAULT 0,
  cota_tva REAL DEFAULT 19,
  stoc_minim REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS depozite (
  id SERIAL PRIMARY KEY,
  denumire TEXT NOT NULL,
  locatie TEXT
);

CREATE TABLE IF NOT EXISTS miscari_stoc (
  id SERIAL PRIMARY KEY,
  produs_id INTEGER NOT NULL REFERENCES produse(id),
  depozit_id INTEGER NOT NULL REFERENCES depozite(id),
  tip TEXT NOT NULL,
  cantitate REAL NOT NULL,
  pret_unitar REAL,
  document_ref TEXT,
  data TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  observatii TEXT
);

CREATE TABLE IF NOT EXISTS comenzi (
  id SERIAL PRIMARY KEY,
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
  numar TEXT,
  data TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  status TEXT NOT NULL DEFAULT 'noua',
  observatii TEXT
);

CREATE TABLE IF NOT EXISTS comenzi_linii (
  id SERIAL PRIMARY KEY,
  comanda_id INTEGER NOT NULL REFERENCES comenzi(id),
  produs_id INTEGER NOT NULL REFERENCES produse(id),
  cantitate REAL NOT NULL,
  pret_unitar REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS facturi (
  id SERIAL PRIMARY KEY,
  serie TEXT DEFAULT 'FCT',
  numar INTEGER,
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
  comanda_id INTEGER REFERENCES comenzi(id),
  directie TEXT NOT NULL DEFAULT 'vanzare',
  data_emiterii TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  data_scadenta TEXT,
  status TEXT NOT NULL DEFAULT 'emisa',
  observatii TEXT,
  sursa_import TEXT,
  smartbill_sync_la TEXT,
  smartbill_serie TEXT,
  smartbill_numar TEXT
);

CREATE TABLE IF NOT EXISTS facturi_linii (
  id SERIAL PRIMARY KEY,
  factura_id INTEGER NOT NULL REFERENCES facturi(id),
  produs_id INTEGER REFERENCES produse(id),
  denumire TEXT NOT NULL,
  cantitate REAL NOT NULL,
  pret_unitar REAL NOT NULL,
  cota_tva REAL DEFAULT 19
);

CREATE TABLE IF NOT EXISTS plati (
  id SERIAL PRIMARY KEY,
  factura_id INTEGER NOT NULL REFERENCES facturi(id),
  suma REAL NOT NULL,
  data TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  metoda TEXT DEFAULT 'transfer bancar',
  observatii TEXT
);

CREATE TABLE IF NOT EXISTS angajati (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  functie TEXT,
  departament TEXT,
  email TEXT,
  telefon TEXT,
  data_angajarii TEXT,
  salariu_baza REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS salarii (
  id SERIAL PRIMARY KEY,
  angajat_id INTEGER NOT NULL REFERENCES angajati(id),
  luna TEXT NOT NULL,
  salariu_brut REAL NOT NULL,
  bonusuri REAL DEFAULT 0,
  deduceri REAL DEFAULT 0,
  cas REAL DEFAULT 0,
  cass REAL DEFAULT 0,
  impozit REAL DEFAULT 0,
  salariu_net REAL DEFAULT 0,
  platit INTEGER DEFAULT 0,
  UNIQUE(angajat_id, luna)
);

-- Utilizatori (multi-user, cu roluri). Parola nu se stochează în clar —
-- doar hash + salt (vezi lib/auth.js).
CREATE TABLE IF NOT EXISTS utilizatori (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  parola_hash TEXT NOT NULL,
  parola_salt TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'vanzari',
  activ INTEGER NOT NULL DEFAULT 1,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- CRM: istoricul de interacțiuni (apeluri, emailuri, întâlniri, notițe) cu
-- fiecare partener, plus o dată opțională de "următorul contact" (folosită
-- pentru lista de follow-up-uri de pe pagina /crm).
CREATE TABLE IF NOT EXISTS interactiuni (
  id SERIAL PRIMARY KEY,
  partener_id INTEGER REFERENCES parteneri(id),
  tip TEXT NOT NULL DEFAULT 'nota',
  subiect TEXT,
  descriere TEXT,
  data TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  data_urmatoare_actiune TEXT
);

-- Rețete de produs (BOM) — din ce componente (alte produse din stoc) e
-- format un produs finit, și în ce cantitate. Folosit de modulul Producție.
CREATE TABLE IF NOT EXISTS retete_componente (
  id SERIAL PRIMARY KEY,
  produs_id INTEGER NOT NULL REFERENCES produse(id),
  componenta_id INTEGER NOT NULL REFERENCES produse(id),
  cantitate REAL NOT NULL DEFAULT 1
);

-- CRM: pipeline de vânzări (oportunități / lead-uri urmărite pe stadii).
CREATE TABLE IF NOT EXISTS oportunitati (
  id SERIAL PRIMARY KEY,
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
  titlu TEXT NOT NULL,
  valoare_estimata REAL DEFAULT 0,
  stadiu TEXT NOT NULL DEFAULT 'lead',
  data_estimata_inchidere TEXT,
  observatii TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- CRM: lead-uri (contacte care încă NU sunt parteneri în ERP). Un lead
-- necalificat n-are ce căuta în lista de clienți — de-aia stă separat, și
-- abia la conversie devine partener + (opțional) oportunitate.
CREATE TABLE IF NOT EXISTS leaduri (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  companie TEXT,
  email TEXT,
  telefon TEXT,
  sursa TEXT DEFAULT 'manual',
  stadiu TEXT NOT NULL DEFAULT 'nou',
  scor INTEGER NOT NULL DEFAULT 0,
  atribuit_lui INTEGER REFERENCES utilizatori(id),
  partener_id INTEGER REFERENCES parteneri(id),
  observatii TEXT,
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  ultima_activitate TEXT
);

-- Task-uri: se pot atribui oricărui utilizator și se pot lega de orice
-- entitate din ERP (partener, lead, oportunitate, comandă, factură).
CREATE TABLE IF NOT EXISTS taskuri (
  id SERIAL PRIMARY KEY,
  titlu TEXT NOT NULL,
  descriere TEXT,
  tip TEXT NOT NULL DEFAULT 'general',
  prioritate TEXT NOT NULL DEFAULT 'normala',
  status TEXT NOT NULL DEFAULT 'deschis',
  scadenta TEXT,
  atribuit_lui INTEGER REFERENCES utilizatori(id),
  creat_de INTEGER REFERENCES utilizatori(id),
  partener_id INTEGER REFERENCES parteneri(id),
  lead_id INTEGER REFERENCES leaduri(id),
  oportunitate_id INTEGER REFERENCES oportunitati(id),
  comanda_id INTEGER REFERENCES comenzi(id),
  factura_id INTEGER REFERENCES facturi(id),
  finalizat_la TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS taskuri_comentarii (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES taskuri(id),
  utilizator_id INTEGER REFERENCES utilizatori(id),
  text TEXT NOT NULL,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- CERERI DE DEZVOLTARE: ce vrea echipa sa se schimbe in SOFT.
--
-- De ce nu stau in "taskuri": acolo e munca firmei (suna clientul, verifica
-- factura). Aici e munca pe aplicatie, si are o poarta pe care taskurile
-- n-o au: o cerere nu ajunge sa fie facuta pana nu o aproba administratorul.
-- Puse la un loc, "schimba modulul de productie" ar sta langa "trimite
-- oferta", iar coada de dezvoltare n-ar mai putea fi citita dintr-o privire.
--
-- Starile: noua -> aprobata -> in_lucru -> livrata, plus respinsa cu motiv.
-- Doar administratorul muta o cerere din "noua"  oricine o poate scrie si
-- oricine poate comenta pe ea.
CREATE TABLE IF NOT EXISTS cereri_dezvoltare (
  id SERIAL PRIMARY KEY,
  titlu TEXT NOT NULL,
  descriere TEXT,
  modul TEXT,
  prioritate TEXT NOT NULL DEFAULT 'normala',
  stare TEXT NOT NULL DEFAULT 'noua',
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  decis_de INTEGER REFERENCES utilizatori(id),
  decis_la TEXT,
  motiv TEXT,
  livrat_la TEXT,
  note_livrare TEXT
);

CREATE TABLE IF NOT EXISTS cereri_dezvoltare_comentarii (
  id SERIAL PRIMARY KEY,
  cerere_id INTEGER NOT NULL REFERENCES cereri_dezvoltare(id),
  utilizator_id INTEGER REFERENCES utilizatori(id),
  text TEXT NOT NULL,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Inchiderea istoricului de facturi vechi.
--
-- DE CE exista: pana la importul de extrase bancare, ERP-ul nu stie nimic
-- despre platile catre furnizori. Fiecare factura de furnizor din 2021
-- incoace ramanea "emisa" si se aduna la "de platit" -- 55 de milioane pe
-- 19.09.2026, fata de ~6,5 milioane furnizori in balanta. Decizia lui Vali:
-- tot ce e mai vechi decat un prag ales de el se marcheaza achitat, ca sa
-- ramana doar ce se potriveste cu balanta.
--
-- Nu se sterge nimic si nu e drum fara intoarcere: fiecare inchidere isi
-- scrie aici id-urile atinse, deci se poate anula in intregime.
CREATE TABLE IF NOT EXISTS inchideri_istoric (
  id SERIAL PRIMARY KEY,
  facut_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  facut_de INTEGER REFERENCES utilizatori(id),
  directie TEXT NOT NULL,
  prag TEXT NOT NULL,
  nr_documente INTEGER NOT NULL DEFAULT 0,
  suma REAL NOT NULL DEFAULT 0,
  ids TEXT,
  anulata_la TEXT,
  anulata_de INTEGER REFERENCES utilizatori(id)
);

-- Achizitii: ce ne oferteaza furnizorii, la ce pret si cand.
--
-- DE CE un set propriu de tabele, si nu „oferte" (alea sunt ofertele NOASTRE
-- catre clienti) si nici „produse": lucrul pe care ti-l oferteaza cinci
-- furnizori nu e un produs din nomenclator, e o CERINTA — „folie stretch
-- jumbo 15 microni" — iar fiecare furnizor ii pune alt nume, alta unitate si
-- alta cantitate minima. Daca am fi tinut ofertele pe produs_id, jumatate
-- n-ar fi avut unde sa stea: marfa pe care inca n-ai cumparat-o niciodata nu
-- exista in nomenclator.
--
-- Legatura cu nomenclatorul ramane optionala (produs_id): cand articolul
-- chiar corespunde unui produs, se leaga si se poate compara pretul ofertat
-- cu pretul real de achizitie.
CREATE TABLE IF NOT EXISTS ach_categorii (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  ordine INTEGER NOT NULL DEFAULT 100,
  activ INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ach_articole (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  categorie_id INTEGER REFERENCES ach_categorii(id),
  produs_id INTEGER REFERENCES produse(id),
  um TEXT DEFAULT 'kg',
  specificatie TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  activ INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ach_articole_categorie ON ach_articole (categorie_id);

-- O oferta = un pret, de la un furnizor, la o data. Furnizorul poate fi un
-- partener din ERP sau doar un nume scris de mana: multi dintre cei care
-- oferteaza (fabrici din Grecia, Ungaria, Turcia) nu sunt inca parteneri, si
-- nu are rost sa-i inregistrezi pana nu cumperi de la ei.
CREATE TABLE IF NOT EXISTS ach_oferte (
  id SERIAL PRIMARY KEY,
  articol_id INTEGER NOT NULL REFERENCES ach_articole(id),
  furnizor_id INTEGER REFERENCES parteneri(id),
  furnizor_text TEXT,
  pret REAL NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'EUR',
  um TEXT,
  cantitate_min REAL,
  conditii TEXT,
  termen_livrare TEXT,
  data_ofertei TEXT NOT NULL,
  valabil_pana TEXT,
  sursa TEXT NOT NULL DEFAULT 'manual',
  email_id TEXT,
  email_subiect TEXT,
  email_de_la TEXT,
  observatii TEXT,
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  activ INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ach_oferte_articol ON ach_oferte (articol_id);
CREATE INDEX IF NOT EXISTS idx_ach_oferte_data ON ach_oferte (data_ofertei);

-- Pretul de referinta din piata, pentru fiecare articol.
--
-- DE CE: o oferta nu inseamna nimic singura. 1,39 €/kg la folie stretch pare
-- bun sau prost numai daca stii cat costa materia prima si cat cere piata. De
-- aia fiecare articol poate avea o estimare de piata, cu sursa si data ei, iar
-- pagina articolului arata pe fata diferenta: oferta cea mai buna e cu atat la
-- suta sub sau peste piata.
--
-- Se tine ca ISTORIC, nu ca un camp pe articol: piata se misca (LLDPE a urcat
-- 7,3% intr-o singura luna in septembrie 2026), si vrei sa vezi ca o oferta
-- buna acum sase luni e scumpa azi. Se afiseaza intotdeauna cea mai recenta.
--
-- pret si pret_max fac o banda: rar exista o singura cifra corecta, de obicei
-- e un interval. Cand piata da o singura valoare, pret_max ramane gol.
CREATE TABLE IF NOT EXISTS ach_piata (
  id SERIAL PRIMARY KEY,
  articol_id INTEGER NOT NULL REFERENCES ach_articole(id),
  pret REAL NOT NULL,
  pret_max REAL,
  moneda TEXT NOT NULL DEFAULT 'EUR',
  um TEXT,
  data TEXT NOT NULL,
  sursa TEXT,
  url TEXT,
  metoda TEXT,
  nota TEXT,
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  activ INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ach_piata_articol ON ach_piata (articol_id);

-- Curatarea facturilor duplicate.
--
-- DE CE: importul a bagat acelasi document de doua-trei ori. Pe 20.09.2026
-- erau 14 numere de vanzare duplicate, 20 de exemplare in plus si 145.658 lei
-- creante care nu exista. Raportul de restante le arata pe toate, corect: nu
-- el greseste, baza are copiile.
--
-- Curatarea pastreaza exemplarul cel mai vechi al fiecarui numar si le pune pe
-- celelalte pe activ = 0. Ca si inchiderea istoricului, se poate da inapoi:
-- id-urile atinse raman scrise aici.
CREATE TABLE IF NOT EXISTS curatari_duplicate (
  id SERIAL PRIMARY KEY,
  facut_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  facut_de INTEGER REFERENCES utilizatori(id),
  directie TEXT NOT NULL,
  nr_documente INTEGER NOT NULL DEFAULT 0,
  suma REAL NOT NULL DEFAULT 0,
  ids TEXT,
  anulata_la TEXT,
  anulata_de INTEGER REFERENCES utilizatori(id)
);

-- DE CE: importul a pus denumirea produsului in coloana „UM", la mii de
-- produse. Repararea e o singura apasare care atinge foarte multe randuri, si
-- pana acum nu se putea da inapoi. Aici se scrie ce era inainte, produs cu
-- produs, ca sa existe un drum de intoarcere.
--
-- vechi tine un JSON cu [id, unitatea veche, unitatea pusa]. La desfacere se
-- pune inapoi doar acolo unde unitatea curenta e inca cea pusa de buton: daca
-- un om a schimbat-o intre timp, ramane cum a pus el.
CREATE TABLE IF NOT EXISTS reparatii_um (
  id SERIAL PRIMARY KEY,
  facut_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  facut_de INTEGER REFERENCES utilizatori(id),
  nr_produse INTEGER NOT NULL DEFAULT 0,
  vechi TEXT,
  anulata_la TEXT,
  anulata_de INTEGER REFERENCES utilizatori(id)
);

-- Bugetul de venituri si cheltuieli.
--
-- DE CE, in cuvintele lui Vali: "un buget de venituri si cheltuieli detaliat
-- cu posibilitate de alterare a campurilor bazat pe ce am deja in conta, cu
-- comparatie 2025 si 2026 si bugetat si realizat pe 2027, la coloanele mari
-- de cheltuieli din balanta sa pot sparge in mai multe conturi related cu
-- categoria".
--
-- Ideea care tine tot: LINIA DE BUGET E O CATEGORIE, nu un cont. Un om nu
-- bugeteaza "contul 628", bugeteaza "servicii". Dar cifrele reale vin din
-- balanta, care e pe conturi. De-aia categoria strange mai multe conturi, iar
-- legatura se poate muta: aduni trei conturi intr-o categorie sau spargi o
-- categorie mare in trei, fara sa atingi balanta.
--
-- Un cont apartine unei SINGURE categorii intr-un an. Altfel ar fi numarat de
-- doua ori, iar totalul bugetului ar fi mai mare decat realitatea fara ca
-- nimic sa para in neregula.
CREATE TABLE IF NOT EXISTS buget_categorii (
  id SERIAL PRIMARY KEY,
  an INTEGER NOT NULL,
  fel TEXT NOT NULL,
  nume TEXT NOT NULL,
  ordine INTEGER NOT NULL DEFAULT 100,
  bugetat REAL NOT NULL DEFAULT 0,
  nota TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_buget_categorii_an ON buget_categorii (an, fel, ordine);

CREATE TABLE IF NOT EXISTS buget_conturi (
  id SERIAL PRIMARY KEY,
  categorie_id INTEGER NOT NULL REFERENCES buget_categorii(id),
  cont TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_buget_conturi_unic ON buget_conturi (categorie_id, cont);
CREATE INDEX IF NOT EXISTS idx_buget_conturi_cont ON buget_conturi (cont);

-- Inventarul fizic: numaram marfa si o punem fata in fata cu scripticul.
--
-- DE CE, in cuvintele lui Vali: "sa verificam fizic produsele din stoc la zi
-- cu realitatea, si sa putem ajusta fizic dupa ce vedem comparativ si ne da
-- exact ce diferente avem si ce valoare la pret de intrare a acelei marfi".
--
-- Doua idei stau la baza:
--
--   1. INVENTARUL E O SESIUNE, nu o apasare. Se deschide, se numara pe rand
--      (poate dura o zi), se vede comparativ, si abia apoi se aplica. Intre
--      timp NIMIC nu se schimba in stoc.
--
--   2. SCRIPTICUL SE FOTOGRAFIAZA LA DESCHIDERE. Daca l-am citi la aplicare,
--      o intrare facuta intre timp ar aparea drept diferenta de inventar si
--      am corecta o cifra care era corecta.
--
-- Aplicarea scrie miscari de tip "inventar" (vezi lib/stoc.js: un inventar
-- inlocuieste stocul, nu se aduna la el), fiecare purtand document_ref
-- "inventar:<id>". De-aia se poate si desface: se sterg exact acele miscari,
-- nimic altceva.
CREATE TABLE IF NOT EXISTS inventare (
  id SERIAL PRIMARY KEY,
  depozit_id INTEGER NOT NULL REFERENCES depozite(id),
  nume TEXT,
  stare TEXT NOT NULL DEFAULT 'deschis',
  deschis_de INTEGER REFERENCES utilizatori(id),
  deschis_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  aplicat_de INTEGER REFERENCES utilizatori(id),
  aplicat_la TEXT,
  desfacut_de INTEGER REFERENCES utilizatori(id),
  desfacut_la TEXT,
  observatii TEXT
);

-- O linie pe produs. "scriptic" e fotografia de la deschidere, "numarat" e ce
-- s-a gasit fizic si ramane NULL pana cand chiar numara cineva: zero gasit si
-- nenumarat inca sunt doua lucruri diferite, iar confundarea lor ar sterge
-- stocul produselor la care nu s-a ajuns.
CREATE TABLE IF NOT EXISTS inventare_linii (
  id SERIAL PRIMARY KEY,
  inventar_id INTEGER NOT NULL REFERENCES inventare(id),
  produs_id INTEGER NOT NULL REFERENCES produse(id),
  scriptic REAL NOT NULL DEFAULT 0,
  numarat REAL,
  pret_intrare REAL,
  pret_din TEXT,
  numarat_de INTEGER REFERENCES utilizatori(id),
  numarat_la TEXT,
  observatii TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventare_linii_unic ON inventare_linii (inventar_id, produs_id);
CREATE INDEX IF NOT EXISTS idx_inventare_depozit ON inventare (depozit_id, stare);

-- Marketing: oamenii din spatele firmelor.
--
-- DE CE un tabel propriu si nu campul de email din parteneri: partenerul are UN
-- email, al firmei. Dar la Aquila vorbesti cu trei oameni, fiecare cu adresa
-- lui, iar de ziua unuia nu-i scrii pe adresa de facturare. Contactul e
-- persoana, iar partenerul e firma din care face parte.
--
-- firma_text exista pentru cazul in care persoana vine de la o firma care nu
-- e inca partener in ERP: un furnizor care ne-a ofertat o data, un lead. Nu
-- inventam un partener doar ca sa avem unde pune omul.
--
-- data_nastere e optionala si poate veni fara an, ca „--03-14": de multe ori
-- stii ziua, nu si anul, iar asta nu trebuie sa te impiedice s-o scrii.
--
-- confirmata spune daca data a fost pusa de un om sau dedusa de import. Numai
-- cele confirmate intra in trimiterea automata de la ora 13 — o felicitare
-- trimisa din greseala, pe o data culeasa strambde dintr-o factura, e mai rea
-- decat una netrimisa.
CREATE TABLE IF NOT EXISTS mk_contacte (
  id SERIAL PRIMARY KEY,
  partener_id INTEGER REFERENCES parteneri(id),
  firma_text TEXT,
  nume TEXT NOT NULL,
  functie TEXT,
  email TEXT,
  telefon TEXT,
  data_nastere TEXT,
  nastere_confirmata INTEGER NOT NULL DEFAULT 0,
  sursa TEXT NOT NULL DEFAULT 'manual',
  observatii TEXT,
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  activ INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mk_contacte_partener ON mk_contacte (partener_id);
CREATE INDEX IF NOT EXISTS idx_mk_contacte_nastere ON mk_contacte (data_nastere);

-- Nimic nu se pierde: orice modificare a unui contact se scrie aici, cu cine
-- si cand. Stergerea e doar a administratorului, si tot aici ramane urma.
-- La trimitere se foloseste intotdeauna valoarea curenta, adica cea mai noua.
CREATE TABLE IF NOT EXISTS mk_contacte_istoric (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES mk_contacte(id),
  camp TEXT NOT NULL,
  valoare_veche TEXT,
  valoare_noua TEXT,
  schimbat_de INTEGER REFERENCES utilizatori(id),
  schimbat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_mk_istoric_contact ON mk_contacte_istoric (contact_id);

-- Felicitarile trimise. Raman toate, si cele trimise de om, si cele plecate
-- automat, ca sa se vada cine a scris si cand — si ca sa nu plece de doua ori
-- in aceeasi zi catre acelasi om.
CREATE TABLE IF NOT EXISTS mk_aniversari (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES mk_contacte(id),
  ziua TEXT NOT NULL,
  email TEXT,
  de_la TEXT,
  subiect TEXT,
  mesaj TEXT,
  trimis_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  trimis_de INTEGER REFERENCES utilizatori(id),
  automat INTEGER NOT NULL DEFAULT 0,
  stare TEXT NOT NULL DEFAULT 'trimis',
  eroare TEXT
);
CREATE INDEX IF NOT EXISTS idx_mk_aniversari_zi ON mk_aniversari (ziua);

-- Emailuri trimise din CRM. Corpul se păstrează ca istoric, ca discuția cu
-- un client să nu depindă de căsuța poștală a unui singur agent.
-- Comenzi de producție ("comenzi în lucru") — flux separat de comenzile de
-- vânzare: agentul inițiază comanda cu data SOLICITATĂ de client, producția
-- răspunde cu data PROPUSĂ și pornește lucrul, iar statusul curge
-- nouă → în producție → finalizată → facturată (sau anulată).
CREATE TABLE IF NOT EXISTS comenzi_productie (
  id SERIAL PRIMARY KEY,
  numar TEXT,
  initiator TEXT,
  initiator_id INTEGER,
  partener_id INTEGER,
  client_text TEXT,
  tip_produs TEXT,
  cantitate TEXT,
  data_initiere TEXT,
  data_solicitata TEXT,
  data_propusa TEXT,
  start_productie TEXT,
  data_finalizare TEXT,
  status TEXT NOT NULL DEFAULT 'noua',
  observatii TEXT,
  reteta TEXT,
  sursa TEXT DEFAULT 'manual',
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Tranzacții bancare importate din extrasul de cont, pentru reconcilierea
-- automată cu facturile emise/primite. Suma e semnată: pozitiv = încasare,
-- negativ = plată.
CREATE TABLE IF NOT EXISTS tranzactii_banca (
  id SERIAL PRIMARY KEY,
  data TEXT NOT NULL,
  suma REAL NOT NULL,
  descriere TEXT,
  referinta TEXT,
  factura_id INTEGER REFERENCES facturi(id),
  status TEXT NOT NULL DEFAULT 'nepotrivita',
  potrivire_motiv TEXT,
  fisier TEXT,
  amprenta TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_tranz_amprenta ON tranzactii_banca (amprenta);

-- Balanțe SmartBill Conta încărcate ca istoric (snapshot pe perioadă) —
-- sursa indicatorilor bancari reali (capitaluri, îndatorare, lichiditate)
-- și a comparațiilor multi-an pe cifre contabile complete.
CREATE TABLE IF NOT EXISTS balante_snapshot (
  id SERIAL PRIMARY KEY,
  eticheta TEXT NOT NULL,
  data_de_la TEXT,
  data_pana TEXT NOT NULL,
  cont TEXT NOT NULL,
  denumire TEXT,
  si_d REAL DEFAULT 0, si_c REAL DEFAULT 0,
  r_d REAL DEFAULT 0, r_c REAL DEFAULT 0,
  ts_d REAL DEFAULT 0, ts_c REAL DEFAULT 0,
  sf_d REAL DEFAULT 0, sf_c REAL DEFAULT 0,
  fisier TEXT,
  incarcat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_balsnap_eticheta ON balante_snapshot (eticheta);

-- Intrări manuale de cash flow (forecast): chirii, rate, taxe, salarii,
-- încasări promise — ce nu reiese din facturile din sistem. Cele recurente
-- se repetă lunar în proiecție până la data de sfârșit (dacă e setată).
CREATE TABLE IF NOT EXISTS cashflow_manual (
  id SERIAL PRIMARY KEY,
  tip TEXT NOT NULL DEFAULT 'iesire',
  suma REAL NOT NULL,
  data TEXT NOT NULL,
  descriere TEXT NOT NULL,
  recurent_lunar INTEGER NOT NULL DEFAULT 0,
  pana_la TEXT,
  creat_de INTEGER,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Firmele grupului. Cash Machine și Warehouse All lucrează cu ACEIAȘI
-- clienți și furnizori și își facturează una alteia — deci în rapoartele
-- de grup facturile dintre ele trebuie ELIMINATE (altfel același leu e
-- numărat de două ori: o dată ca venit la una, o dată ca și cost la
-- cealaltă). Partenerii rămân comuni, o singură listă pentru tot grupul.
CREATE TABLE IF NOT EXISTS firme (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  cui TEXT,
  culoare TEXT DEFAULT '#2f5d9c',
  in_grup INTEGER NOT NULL DEFAULT 1,
  implicita INTEGER NOT NULL DEFAULT 0
);

-- Costul lunar real al fiecărui om din echipă: salariu + contribuții +
-- mașină + carburant + altele. Ținut ca ISTORIC (fiecare rând e valabil de
-- la o dată încolo), ca să nu se strice rapoartele pe lunile trecute când
-- se mărește un salariu sau se schimbă mașina.
--
-- Costul pentru firmă = salariul BRUT + CAM (contribuția asiguratorie
-- pentru muncă, plătită de angajator peste brut) + costurile cu mașina.
-- CAS/CASS/impozitul se rețin DIN brut, deci nu se adună peste el — altfel
-- costul ar ieși umflat.
-- CRM: oferte, cu versionare.
--
-- O ofertă nu se corectează peste ea însăși: fiecare revizie e o linie nouă,
-- cu versiune+1, care arată spre rădăcină (radacina_id). Cea veche rămâne
-- pe „inlocuita", ca să se vadă exact ce i-ai trimis clientului și când —
-- altfel, la o discuție despre preț, nimeni nu mai știe ce s-a promis.
CREATE TABLE IF NOT EXISTS oferte (
  id SERIAL PRIMARY KEY,
  numar TEXT,
  versiune INTEGER NOT NULL DEFAULT 1,
  radacina_id INTEGER,
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
  oportunitate_id INTEGER REFERENCES oportunitati(id),
  agent_id INTEGER REFERENCES utilizatori(id),
  titlu TEXT,
  status TEXT NOT NULL DEFAULT 'ciorna',
  valabil_pana TEXT,
  observatii TEXT,
  motiv_respingere TEXT,
  trimisa_la TEXT,
  acceptata_la TEXT,
  contract_id INTEGER,
  comanda_id INTEGER REFERENCES comenzi(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_oferte_partener ON oferte (partener_id);
CREATE INDEX IF NOT EXISTS idx_oferte_radacina ON oferte (radacina_id);

CREATE TABLE IF NOT EXISTS oferte_linii (
  id SERIAL PRIMARY KEY,
  oferta_id INTEGER NOT NULL REFERENCES oferte(id),
  produs_id INTEGER REFERENCES produse(id),
  denumire TEXT NOT NULL,
  um TEXT DEFAULT 'buc',
  cantitate REAL NOT NULL DEFAULT 1,
  pret_unitar REAL NOT NULL DEFAULT 0,
  cota_tva REAL NOT NULL DEFAULT 21
);
CREATE INDEX IF NOT EXISTS idx_oferte_linii ON oferte_linii (oferta_id);

-- Contracte. Se pot naște dintr-o ofertă acceptată sau direct — de-aia
-- oferta_id e opțional. Din orice pas se poate sări direct la contract sau
-- la comandă: fluxul e o sugestie, nu o cușcă.
CREATE TABLE IF NOT EXISTS contracte (
  id SERIAL PRIMARY KEY,
  numar TEXT,
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
  oferta_id INTEGER REFERENCES oferte(id),
  agent_id INTEGER REFERENCES utilizatori(id),
  titlu TEXT,
  valoare REAL NOT NULL DEFAULT 0,
  data_semnare TEXT,
  data_start TEXT,
  data_final TEXT,
  status TEXT NOT NULL DEFAULT 'in_lucru',
  observatii TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_contracte_partener ON contracte (partener_id);

-- Profitabilitatea pe produs, așa cum o calculează SmartBill Gestiune, cu
-- costul real al bunurilor vândute. O ținem separat de „produse" pentru că e
-- o fotografie pe o perioadă, nu o proprietate a produsului: același produs
-- are altă marjă de la o lună la alta.
CREATE TABLE IF NOT EXISTS profit_produs (
  id SERIAL PRIMARY KEY,
  produs_id INTEGER,
  denumire TEXT NOT NULL,
  cod TEXT,
  gestiune TEXT,
  vanzari_brute REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  vanzari_nete REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  marja_pct REAL NOT NULL DEFAULT 0,
  perioada TEXT,
  actualizat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_profit_produs_den ON profit_produs (denumire);

-- Cutia poștală a punții de import. Datele citite din browser aterizează
-- aici, NU direct în tabelele reale: administratorul vede ce a sosit și
-- apasă „Aplică". Așa ruta de primire n-are nevoie de nicio parolă sau
-- token — nimic din ce intră nu atinge datele firmei fără aprobare.
CREATE TABLE IF NOT EXISTS punte_staging (
  id SERIAL PRIMARY KEY,
  tip TEXT NOT NULL,
  randuri INTEGER NOT NULL DEFAULT 0,
  octeti INTEGER NOT NULL DEFAULT 0,
  continut TEXT NOT NULL,
  sursa TEXT,
  primit_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  aplicat_la TEXT,
  rezultat TEXT
);
CREATE INDEX IF NOT EXISTS idx_punte_staging_primit ON punte_staging (primit_la);

-- Jurnalul sincronizarilor automate de noapte. Fara el, singura urma a unei
-- rulari erau logurile de acces ale serverului, in care o rulare care n-a
-- gasit nimic arata exact ca una care a esuat.
CREATE TABLE IF NOT EXISTS sync_rulari (
  id SERIAL PRIMARY KEY,
  pornit_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  stare TEXT NOT NULL DEFAULT 'ok',
  sursa TEXT,
  gasit INTEGER NOT NULL DEFAULT 0,
  importat INTEGER NOT NULL DEFAULT 0,
  nota TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_rulari_pornit ON sync_rulari (pornit_la);

CREATE TABLE IF NOT EXISTS punti_import (
  token TEXT PRIMARY KEY,
  creat_de INTEGER,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  expira_la TEXT NOT NULL,
  folosit_de TEXT,
  randuri_primite INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alias_parteneri (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL,
  partener_id INTEGER NOT NULL,
  sursa TEXT DEFAULT 'manual',
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_alias_alias ON alias_parteneri (alias);

CREATE TABLE IF NOT EXISTS alocari_clienti (
  id SERIAL PRIMARY KEY,
  partener_id INTEGER NOT NULL,
  utilizator_id INTEGER NOT NULL,
  procent REAL NOT NULL DEFAULT 100,
  observatii TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_alocari_partener ON alocari_clienti (partener_id);
CREATE INDEX IF NOT EXISTS idx_alocari_utilizator ON alocari_clienti (utilizator_id);

CREATE TABLE IF NOT EXISTS costuri_personal (
  id SERIAL PRIMARY KEY,
  utilizator_id INTEGER,
  angajat_id INTEGER,
  valabil_de_la TEXT NOT NULL,
  salariu_brut REAL NOT NULL DEFAULT 0,
  cam_procent REAL NOT NULL DEFAULT 2.25,
  cost_masina REAL NOT NULL DEFAULT 0,
  masina_detalii TEXT,
  cost_carburant REAL NOT NULL DEFAULT 0,
  alte_costuri REAL NOT NULL DEFAULT 0,
  alte_detalii TEXT,
  observatii TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_costuri_pers ON costuri_personal (utilizator_id, valabil_de_la);

-- Data angajării, ca istoricul de cost să știe de când începe.

-- Sesiunile de login, ținute în BAZA DE DATE, nu în memoria procesului.
-- Cu sesiuni în memorie, fiecare redeploy sau restart al serviciului
-- deconecta toți utilizatorii — inacceptabil când 4 oameni intră zilnic.
CREATE TABLE IF NOT EXISTS sesiuni (
  token TEXT PRIMARY KEY,
  utilizator_id INTEGER NOT NULL,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  expira_la TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiuni_exp ON sesiuni (expira_la);

-- ========================= CONTABILITATE =========================
-- Planul de conturi. Se populează automat la prima pornire din
-- lib/plan-conturi.js, dar rămâne editabil (poți adăuga analitice proprii).
CREATE TABLE IF NOT EXISTS plan_conturi (
  simbol TEXT PRIMARY KEY,
  denumire TEXT NOT NULL,
  functiune TEXT NOT NULL DEFAULT 'B',
  clasa TEXT,
  grupa TEXT,
  activ INTEGER NOT NULL DEFAULT 1
);

-- Înregistrări contabile (o linie = o sumă pe un cont, pe debit sau credit).
-- Un document generează mai multe linii, legate prin acelaşi nota_id.
--
-- „sursa" spune de unde vine linia şi cine are voie s-o şteargă:
--   auto         — generată din documentele ERP (se regenerează integral)
--   sold_initial — soldurile de deschidere preluate din balanţa contabilului
--   manual       — notă contabilă introdusă de om (NU se atinge la regenerare)
CREATE TABLE IF NOT EXISTS inregistrari_contabile (
  id SERIAL PRIMARY KEY,
  nota_id TEXT NOT NULL,
  data TEXT NOT NULL,
  cont TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  explicatie TEXT,
  document_tip TEXT,
  document_id INTEGER,
  partener_id INTEGER,
  sursa TEXT NOT NULL DEFAULT 'auto',
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_inreg_data ON inregistrari_contabile (data);
CREATE INDEX IF NOT EXISTS idx_inreg_cont ON inregistrari_contabile (cont);
CREATE INDEX IF NOT EXISTS idx_inreg_sursa ON inregistrari_contabile (sursa);

-- Jurnal al regenerărilor, ca să ştii când a fost recalculată ultima dată
-- contabilitatea şi pe ce volum de documente.
CREATE TABLE IF NOT EXISTS contabilitate_rulari (
  id SERIAL PRIMARY KEY,
  rulat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  linii_generate INTEGER,
  documente INTEGER,
  durata_ms INTEGER,
  declansat_de TEXT
);

-- Notificări de recuperare a creanțelor (dunning). Se păstrează fiecare mesaj
-- trimis, ca să se vadă exact ce i s-a scris clientului și când -- la o
-- discuție despre restanțe, "v-am tot scris" nu ține loc de dovadă.
-- Setări simple, cheie-valoare, pentru lucrurile care nu merită tabel propriu
-- (de ex. de la ce dată încolo scadențarul trimite notificări automate).
-- Agenda din afara ERP-ului: întâlniri din Google Calendar, remindere și
-- task-uri programate. ERP-ul nu poate întreba singur Google-ul, așa că le
-- sincronizează Claude periodic, iar „actualizat_la" spune cât de proaspete sunt.
CREATE TABLE IF NOT EXISTS agenda_externa (
  id SERIAL PRIMARY KEY,
  sursa TEXT NOT NULL DEFAULT 'calendar',
  titlu TEXT NOT NULL,
  detalii TEXT,
  incepe_la TEXT,
  se_termina_la TEXT,
  link TEXT,
  cheie_externa TEXT,
  actualizat_la TEXT
);

-- Știri relevante pentru business, sincronizate periodic. Ținem și motivul
-- pentru care contează — un titlu fără „de ce mă privește" e zgomot.
CREATE TABLE IF NOT EXISTS stiri (
  id SERIAL PRIMARY KEY,
  titlu TEXT NOT NULL,
  sursa TEXT,
  url TEXT,
  rezumat TEXT,
  zona TEXT NOT NULL DEFAULT 'local',
  relevanta TEXT,
  publicat_la TEXT,
  adaugat_la TEXT
);

CREATE TABLE IF NOT EXISTS setari_app (
  cheie TEXT PRIMARY KEY,
  valoare TEXT,
  actualizat_la TEXT
);

CREATE TABLE IF NOT EXISTS notificari_facturi (
  id SERIAL PRIMARY KEY,
  factura_id INTEGER NOT NULL REFERENCES facturi(id),
  partener_id INTEGER REFERENCES parteneri(id),
  tip TEXT NOT NULL DEFAULT 'intarziere',
  zile INTEGER,
  catre TEXT,
  subiect TEXT,
  corp TEXT,
  automat INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'trimis',
  eroare TEXT,
  utilizator_id INTEGER REFERENCES utilizatori(id),
  trimis_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS emailuri (
  id SERIAL PRIMARY KEY,
  utilizator_id INTEGER REFERENCES utilizatori(id),
  partener_id INTEGER REFERENCES parteneri(id),
  lead_id INTEGER REFERENCES leaduri(id),
  oportunitate_id INTEGER REFERENCES oportunitati(id),
  catre TEXT NOT NULL,
  cc TEXT,
  subiect TEXT NOT NULL,
  corp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trimis',
  eroare TEXT,
  trimis_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Rezervare de stoc pentru o linie de comanda. Agentul poate tine marfa
-- deoparte, dar nu la nesfarsit: „expira_la" e ora la care rezervarea cade
-- singura, iar marfa redevine disponibila pentru toata lumea.
CREATE TABLE IF NOT EXISTS rezervari_stoc (
  id SERIAL PRIMARY KEY,
  comanda_id INTEGER NOT NULL,
  linie_id INTEGER,
  produs_id INTEGER NOT NULL,
  cantitate REAL NOT NULL DEFAULT 0,
  creata_la TEXT,
  expira_la TEXT,
  stare TEXT NOT NULL DEFAULT 'activa',
  creata_de TEXT
);

-- Ce lipseste din depozit si de unde se aduce: de la un tert (furnizor) sau
-- din productie proprie. Un rand se naste cand operatorul din depozit vede
-- ca stocul nu acopera comanda.
CREATE TABLE IF NOT EXISTS aprovizionari (
  id SERIAL PRIMARY KEY,
  comanda_id INTEGER,
  linie_id INTEGER,
  produs_id INTEGER NOT NULL,
  cantitate REAL NOT NULL DEFAULT 0,
  sursa TEXT NOT NULL DEFAULT 'tert',
  furnizor_id INTEGER,
  productie_id INTEGER,
  termen_cerut TEXT,
  termen_confirmat TEXT,
  status TEXT NOT NULL DEFAULT 'ceruta',
  cerut_de TEXT,
  creata_la TEXT,
  raspuns TEXT,
  observatii TEXT
);

-- Drumul invers: productia cere materie prima de la depozit. Depozitul
-- valideaza si da un termen, exact ca productia pentru comenzile lui.
CREATE TABLE IF NOT EXISTS cereri_materie_prima (
  id SERIAL PRIMARY KEY,
  produs_id INTEGER,
  descriere TEXT,
  cantitate REAL NOT NULL DEFAULT 0,
  um TEXT DEFAULT 'kg',
  termen_cerut TEXT,
  termen_confirmat TEXT,
  status TEXT NOT NULL DEFAULT 'ceruta',
  cerut_de TEXT,
  productie_id INTEGER,
  creata_la TEXT,
  raspuns TEXT,
  observatii TEXT
);

-- Categorii si formule pentru calculatorul de pret. Formula e o expresie
-- simpla peste variabilele definite in „campuri", evaluata controlat.
CREATE TABLE IF NOT EXISTS calculator_categorii (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  descriere TEXT,
  campuri TEXT,
  formula_cost TEXT,
  um TEXT DEFAULT 'kg',
  activ INTEGER NOT NULL DEFAULT 1,
  actualizat_la TEXT
);

-- PRODUCTIE: utilajele din atelier. Capacitatea NU e o proprietate a
-- masinii, ci a perechii masina-produs: aceeasi masina scoate 40 de role pe
-- ora dintr-un produs si 6 din altul. De-aia sta in tabelul de mai jos, nu
-- aici. Aici stau doar lucrurile care tin de masina insasi: cati oameni ii
-- trebuie ca sa mearga si cate ore pe zi e disponibila.
CREATE TABLE IF NOT EXISTS utilaje (
  id SERIAL PRIMARY KEY,
  cod TEXT,
  denumire TEXT NOT NULL,
  descriere TEXT,
  locatie TEXT,
  operatori_necesari INTEGER NOT NULL DEFAULT 1,
  ore_pe_zi REAL NOT NULL DEFAULT 8,
  activ INTEGER NOT NULL DEFAULT 1,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Cat scoate un utilaj dintr-un produs intr-o ora. Cifra o scrie operatorul,
-- nu o deduce nimeni din facturi: e cunoasterea din atelier. „produs_text"
-- exista pentru cazul in care produsul comandat nu e inca in catalog, ca sa
-- se poata estima si atunci.
CREATE TABLE IF NOT EXISTS utilaje_capacitate (
  id SERIAL PRIMARY KEY,
  utilaj_id INTEGER NOT NULL REFERENCES utilaje(id),
  produs_id INTEGER,
  produs_text TEXT,
  cantitate_ora REAL NOT NULL DEFAULT 0,
  um TEXT,
  timp_pregatire REAL NOT NULL DEFAULT 0,
  observatii TEXT
);

-- Oamenii din productie. Legati de „angajati" acolo unde persoana e pe stat,
-- ca sa nu se tina numele in doua locuri, dar se poate scrie si un nume
-- liber (colaborator, om nou, schimb de noapte imprumutat).
CREATE TABLE IF NOT EXISTS resurse (
  id SERIAL PRIMARY KEY,
  nume TEXT NOT NULL,
  angajat_id INTEGER,
  functie TEXT,
  schimb TEXT,
  ore_pe_zi REAL NOT NULL DEFAULT 8,
  activ INTEGER NOT NULL DEFAULT 1,
  observatii TEXT
);

-- Ce utilaj stie sa lucreze fiecare om. Fara asta, „cine poate lucra comanda
-- asta" n-are raspuns, iar planificarea e doar o lista de masini.
CREATE TABLE IF NOT EXISTS resurse_competente (
  id SERIAL PRIMARY KEY,
  resursa_id INTEGER NOT NULL REFERENCES resurse(id),
  utilaj_id INTEGER NOT NULL REFERENCES utilaje(id),
  nivel INTEGER NOT NULL DEFAULT 2
);

-- Alocarea unei comenzi de productie pe un utilaj, la o data si o ora, cu
-- oamenii pusi pe ea. O comanda poate avea mai multe alocari (doua zile pe
-- aceeasi masina, sau doua masini in paralel).
CREATE TABLE IF NOT EXISTS alocari_productie (
  id SERIAL PRIMARY KEY,
  comanda_productie_id INTEGER NOT NULL REFERENCES comenzi_productie(id),
  utilaj_id INTEGER REFERENCES utilaje(id),
  data TEXT NOT NULL,
  ora_start REAL NOT NULL DEFAULT 8,
  ore REAL NOT NULL DEFAULT 0,
  cantitate REAL,
  status TEXT NOT NULL DEFAULT 'planificata',
  observatii TEXT,
  creat_de TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS alocari_resurse (
  id SERIAL PRIMARY KEY,
  alocare_id INTEGER NOT NULL REFERENCES alocari_productie(id),
  resursa_id INTEGER NOT NULL REFERENCES resurse(id)
);

-- DEPOZIT CT-PARK: harta locurilor de palet.
--
-- Un rand de raft e impartit in campuri (deschiderile dintre montanti) si in
-- niveluri. Fiecare camp, la fiecare nivel, tine trei paleti unul langa
-- altul. Adresa unui loc e „R3-05-2-1": randul 3, campul 5, nivelul 2,
-- pozitia 1. Aia se scrie pe eticheta si aia se striga in hala.
CREATE TABLE IF NOT EXISTS ct_randuri (
  id SERIAL PRIMARY KEY,
  numar INTEGER NOT NULL,
  eticheta TEXT,
  niveluri INTEGER NOT NULL DEFAULT 4,
  campuri INTEGER NOT NULL DEFAULT 10,
  locuri_pe_camp INTEGER NOT NULL DEFAULT 3,
  latime_loc INTEGER NOT NULL DEFAULT 900,
  adancime_loc INTEGER NOT NULL DEFAULT 1100,
  inaltime_nivel INTEGER NOT NULL DEFAULT 1800,
  depozit_id INTEGER,
  activ INTEGER NOT NULL DEFAULT 1
);

-- Un loc de palet. „categorie" se pune pe zona de trei locuri dintr-un camp,
-- nu pe locul singur — asa a cerut depozitul: zona de trei paleti e unitatea
-- pe care o rezervi unei categorii de marfa.
CREATE TABLE IF NOT EXISTS ct_locuri (
  id SERIAL PRIMARY KEY,
  rand_id INTEGER NOT NULL REFERENCES ct_randuri(id),
  nivel INTEGER NOT NULL,
  camp INTEGER NOT NULL,
  pozitie INTEGER NOT NULL,
  adresa TEXT NOT NULL,
  categorie TEXT,
  blocat INTEGER NOT NULL DEFAULT 0
);

-- Un palet intrat in depozit. Marfa lata sta pe doua sau trei locuri: de-aia
-- legatura palet-loc e un tabel separat, nu o coloana.
CREATE TABLE IF NOT EXISTS ct_paleti (
  id SERIAL PRIMARY KEY,
  cod TEXT NOT NULL,
  produs_id INTEGER,
  produs_text TEXT,
  cantitate REAL,
  um TEXT,
  lot TEXT,
  categorie TEXT,
  data_intrare TEXT NOT NULL,
  data_iesire TEXT,
  observatii TEXT,
  creat_de TEXT
);

-- Iesirile de marfa din CT-Park.
--
-- O paleta nu pleaca "in gol": la iesire se spune obligatoriu unde se duce —
-- in productie, la fulfillment, sau pe o comanda anume. De-aia destinatia e
-- coloana, nu observatie.
--
-- Clientul, numarul comenzii si adresa de unde a plecat se scriu aici ca
-- fotografie, nu prin JOIN: peste sase luni comanda poate fi redenumita sau
-- stearsa, iar eticheta tiparita trebuie sa ramana adevarata.
CREATE TABLE IF NOT EXISTS ct_iesiri (
  id SERIAL PRIMARY KEY,
  palet_id INTEGER NOT NULL REFERENCES ct_paleti(id),
  destinatie TEXT NOT NULL,
  comanda_id INTEGER,
  client TEXT,
  comanda_numar TEXT,
  comanda_data TEXT,
  adresa TEXT,
  data TEXT NOT NULL,
  observatii TEXT,
  creat_de TEXT
);

CREATE TABLE IF NOT EXISTS ct_ocupari (
  id SERIAL PRIMARY KEY,
  palet_id INTEGER NOT NULL REFERENCES ct_paleti(id),
  loc_id INTEGER NOT NULL REFERENCES ct_locuri(id)
);

-- Nivelurile unui rand, cand nu sunt toate la fel.
--
-- Un rand are N niveluri, iar pana acum toate aveau aceeasi inaltime si
-- acelasi numar de paleti pe camp. In realitate nivelul de jos tine paleti
-- inalti, iar cel de sus cutii mici. Tabelul asta tine DOAR abaterile: un
-- nivel care nu are rand aici mosteneste cifrele randului, deci un depozit
-- configurat inainte merge mai departe fara nicio migrare de date.
CREATE TABLE IF NOT EXISTS ct_niveluri (
  id SERIAL PRIMARY KEY,
  rand_id INTEGER NOT NULL REFERENCES ct_randuri(id),
  nivel INTEGER NOT NULL,
  inaltime INTEGER,
  eticheta TEXT,
  locuri_pe_camp INTEGER
);

-- Cererile de comision ale agentilor.
--
-- Comisionul nu se plateste singur: agentul il CERE, o data pe luna, in
-- fereastra de la 25 pana la sfarsitul lunii. Poate cere si mai putin decat
-- are — ce nu cere ramane si se reporteaza in luna urmatoare. De-aia tinem
-- cererile, nu un sold: soldul se recalculeaza mereu din incasari minus ce
-- s-a cerut, si nu poate iesi din sincron cu realitatea.
--
-- „baza" si „procent" sunt fotografia de la momentul cererii: daca se
-- schimba procentul agentului peste o luna, cererea veche ramane ce a fost.
CREATE TABLE IF NOT EXISTS cereri_comision (
  id SERIAL PRIMARY KEY,
  utilizator_id INTEGER NOT NULL REFERENCES utilizatori(id),
  luna TEXT NOT NULL,
  baza REAL NOT NULL DEFAULT 0,
  procent REAL NOT NULL DEFAULT 0,
  disponibil REAL NOT NULL DEFAULT 0,
  suma_ceruta REAL NOT NULL DEFAULT 0,
  observatii TEXT,
  email_stare TEXT,
  creata_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Preturile concurentei, asa cum le afla oamenii din piata.
--
-- Doua fete ale aceluiasi lucru, tinute in acelasi tabel si despartite prin
-- coloana directie: la VANZARE e pretul cu care ne bate concurenta la client,
-- la ACHIZITIE e pretul pe care il ia altcineva de la furnizor. Un pret fara
-- data e o barfa, nu o informatie, de-aia data_ofertei e obligatorie si e
-- data la care stim ca pretul era valabil, nu data la care l-am scris.
--
-- Se adauga de pe ofertare (de vanzare sau de achizitie), dar poate sta si
-- singur: multe preturi se afla la telefon sau la targ, fara nicio oferta
-- deschisa. Nimic nu se sterge de tot, se dezactiveaza doar, fiindca un pret
-- vechi e exact ce trebuie ca sa vezi cum s-a miscat piata.
CREATE TABLE IF NOT EXISTS concurenta_preturi (
  id SERIAL PRIMARY KEY,
  directie TEXT NOT NULL DEFAULT 'vanzare',
  produs_id INTEGER REFERENCES produse(id),
  denumire TEXT NOT NULL,
  concurent TEXT NOT NULL,
  pret REAL NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'RON',
  um TEXT,
  cantitate REAL,
  data_ofertei TEXT NOT NULL,
  sursa TEXT,
  oferta_id INTEGER REFERENCES oferte(id),
  ach_articol_id INTEGER REFERENCES ach_articole(id),
  partener_id INTEGER REFERENCES parteneri(id),
  observatii TEXT,
  activ INTEGER NOT NULL DEFAULT 1,
  creat_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_conc_directie ON concurenta_preturi (directie, data_ofertei);
CREATE INDEX IF NOT EXISTS idx_conc_oferta ON concurenta_preturi (oferta_id);
CREATE INDEX IF NOT EXISTS idx_conc_articol ON concurenta_preturi (ach_articol_id);
CREATE INDEX IF NOT EXISTS idx_conc_produs ON concurenta_preturi (produs_id);

-- Emailul adus in ERP, ca munca sa aiba un singur loc.
--
-- Casutele conectate. „comun" inseamna o casuta pe care o vede toata lumea
-- care are dreptul la modulul de email (office@, de exemplu), „personal"
-- inseamna ca o vede doar omul ei si administratorul. Impartirea asta e tot
-- ce tine loc de confidentialitate, deci se pune la adaugarea casutei, nu
-- dupa ce au intrat mesajele.
--
-- history_id e cursorul Gmail: contorul de schimbari de la care se reia
-- citirea. Fara el, fiecare sincronizare ar reciti toata casuta sau, mai rau,
-- ar sari peste ce a intrat intre doua rulari.
CREATE TABLE IF NOT EXISTS email_conturi (
  id SERIAL PRIMARY KEY,
  adresa TEXT NOT NULL UNIQUE,
  eticheta TEXT,
  tip TEXT NOT NULL DEFAULT 'personal',
  utilizator_id INTEGER REFERENCES utilizatori(id),
  activ INTEGER NOT NULL DEFAULT 1,
  history_id TEXT,
  ultima_sincronizare TEXT,
  ultima_eroare TEXT,
  mesaje_aduse INTEGER NOT NULL DEFAULT 0,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Un mesaj. Corpul se pastreaza trunchiat: ERP-ul nu e arhiva de email, e
-- locul in care vezi CE s-a vorbit cu un partener si pe ce document. Gmail
-- ramane sursa pentru textul intreg, iar gmail_id e legatura catre el.
CREATE TABLE IF NOT EXISTS email_mesaje (
  id SERIAL PRIMARY KEY,
  cont_id INTEGER NOT NULL REFERENCES email_conturi(id),
  gmail_id TEXT NOT NULL,
  fir_id TEXT,
  data TEXT,
  de_la TEXT,
  de_la_nume TEXT,
  de_la_domeniu TEXT,
  catre TEXT,
  cc TEXT,
  subiect TEXT,
  snippet TEXT,
  corp TEXT,
  directie TEXT NOT NULL DEFAULT 'primit',
  etichete TEXT,
  nr_atasamente INTEGER NOT NULL DEFAULT 0,
  partener_id INTEGER REFERENCES parteneri(id),
  oferta_id INTEGER REFERENCES oferte(id),
  factura_id INTEGER REFERENCES facturi(id),
  legat_cum TEXT,
  activ INTEGER NOT NULL DEFAULT 1,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_mesaj_unic ON email_mesaje (cont_id, gmail_id);

-- Istoricul serviciului de culegere din emailuri (ruleaza noaptea, la 02:00).
-- Se tine ca sa se vada ce a facut si cand: un serviciu care lucreaza singur,
-- noaptea, si nu lasa urma, e un serviciu in care nimeni n-are incredere.
-- Ofertele citite din emailuri, inainte de a deveni oferte adevarate.
--
-- De ce nu intra direct in ach_oferte: pretul dintr-un email e text liber.
-- "12,50 lei/kg" poate fi pretul marfii, al transportului, sau o valoare
-- dintr-o discutie veche citata mai jos in fir. O oferta gresita intrata in
-- Procurement strica media pe articol si decizia de achizitie care se ia din
-- ea, fara ca nimeni sa observe. Asa ca ce nu se potriveste EXACT pe un
-- articol asteapta aici, cu un om care apasa un buton.
-- Harta domeniu -> partener. Inima legarii emailurilor de firme.
--
-- Problema, masurata pe datele reale: din 1.805 mesaje intrate, 1.789 erau
-- "de atribuit". Fisa partenerului are UN singur camp email, de obicei gol sau
-- adresa de facturare, iar oamenii scriu de pe adresele lor. Asa ca nici
-- potrivirea pe adresa, nici cea pe domeniu nu aveau de unde sa nimereasca.
--
-- Solutia nu e o regula mai destepta, ci memorie: cand un om atribuie un mesaj
-- unui partener, domeniul expeditorului ramane legat de acel partener. Toate
-- mesajele de pe domeniul ala - cele vechi si cele viitoare - se leaga singure.
-- Un clic per furnizor, o data in viata.
-- Expeditorii pe care nu-i mai aducem in ERP.
--
-- Inboxul firmei nu e numai munca: e si reclama, si newsletter, si robotul
-- care trimite acelasi raport in fiecare dimineata. Alea intra la fel de bine
-- ca un mesaj de la un client, umfla lista si fac "de atribuit" un teanc prin
-- care nu mai trece nimeni.
--
-- Nu se filtreaza dupa cuvinte si nu se ghiceste ce e reclama: omul care
-- vede mesajul apasa o data "nu mai aduce de aici", iar de-atunci expeditorul
-- ala nu mai intra. In timp lista se aseaza singura, fara ca cineva sa fi
-- scris vreo regula.
--
-- "fel" spune cat de larg blocam: o adresa anume, sau tot domeniul. Blocarea
-- e in ERP, nu in Gmail — mesajele raman la locul lor in casuta, doar ca
-- ERP-ul nu se mai uita la ele.
CREATE TABLE IF NOT EXISTS email_blocate (
  id SERIAL PRIMARY KEY,
  fel TEXT NOT NULL DEFAULT 'adresa',
  valoare TEXT NOT NULL,
  motiv TEXT,
  mesaje_scoase INTEGER NOT NULL DEFAULT 0,
  activ INTEGER NOT NULL DEFAULT 1,
  pus_de INTEGER REFERENCES utilizatori(id),
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_blocate_unic ON email_blocate (fel, lower(valoare));

CREATE TABLE IF NOT EXISTS email_domenii (
  id SERIAL PRIMARY KEY,
  domeniu TEXT NOT NULL,
  partener_id INTEGER NOT NULL,
  -- de unde stim: "om" (cineva a atribuit un mesaj), "fisa" (domeniul din
  -- emailul partenerului), "nume" (numele firmei seamana cu domeniul, si un
  -- om a confirmat). Ultima NU se aplica niciodata singura.
  sursa TEXT NOT NULL DEFAULT 'om',
  pus_de INTEGER,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_domenii_unic ON email_domenii (lower(domeniu));

CREATE TABLE IF NOT EXISTS email_oferte (
  id SERIAL PRIMARY KEY,
  mesaj_id INTEGER NOT NULL,
  partener_id INTEGER,
  furnizor_text TEXT,
  linie TEXT,
  text_produs TEXT,
  articol_id INTEGER,
  pret REAL,
  moneda TEXT DEFAULT 'RON',
  um TEXT,
  data_ofertei TEXT,
  stare TEXT NOT NULL DEFAULT 'de_confirmat',
  ach_oferta_id INTEGER,
  confirmat_de INTEGER,
  confirmat_la TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_email_oferte_stare ON email_oferte (stare);
CREATE INDEX IF NOT EXISTS idx_email_oferte_mesaj ON email_oferte (mesaj_id);

CREATE TABLE IF NOT EXISTS culegere_istoric (
  id SERIAL PRIMARY KEY,
  rulat_la TEXT,
  rezumat TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_data ON email_mesaje (data DESC);
CREATE INDEX IF NOT EXISTS idx_email_partener ON email_mesaje (partener_id);
CREATE INDEX IF NOT EXISTS idx_email_domeniu ON email_mesaje (de_la_domeniu);
CREATE INDEX IF NOT EXISTS idx_email_oferta ON email_mesaje (oferta_id);
CREATE INDEX IF NOT EXISTS idx_email_factura ON email_mesaje (factura_id);

-- Atasamentele. Fisierul sta in Drive, in baza raman doar identificatorul,
-- linkul si amprenta md5 — dupa ea se vede ca acelasi document trimis de
-- cinci ori e un singur fisier, nu cinci.
CREATE TABLE IF NOT EXISTS email_atasamente (
  id SERIAL PRIMARY KEY,
  mesaj_id INTEGER NOT NULL REFERENCES email_mesaje(id),
  nume TEXT NOT NULL,
  mime TEXT,
  marime INTEGER NOT NULL DEFAULT 0,
  md5 TEXT,
  drive_id TEXT,
  drive_link TEXT,
  duplicat INTEGER NOT NULL DEFAULT 0,
  eroare TEXT,
  creat_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_email_atas_mesaj ON email_atasamente (mesaj_id);
CREATE INDEX IF NOT EXISTS idx_email_atas_md5 ON email_atasamente (md5);

`;

// Coloane adăugate ulterior primei versiuni a schemei. "CREATE TABLE IF NOT
// EXISTS" de mai sus nu modifică un tabel deja existent pe o bază de date
// live — de-aia coloanele noi se adaugă separat, idempotent, cu ALTER TABLE
// ... ADD COLUMN IF NOT EXISTS (sigur de rulat de fiecare dată la pornire).
const ALTERARI = `
-- Legatura dintre un email si ce s-a nascut din el. Fara ele, serviciul ar
-- face al doilea task si a doua comanda la fiecare rulare.
ALTER TABLE email_mesaje ADD COLUMN IF NOT EXISTS fel TEXT;
ALTER TABLE email_mesaje ADD COLUMN IF NOT EXISTS task_id INTEGER;
ALTER TABLE email_mesaje ADD COLUMN IF NOT EXISTS comanda_id INTEGER;
ALTER TABLE email_mesaje ADD COLUMN IF NOT EXISTS clasificat_la TEXT;
CREATE INDEX IF NOT EXISTS idx_email_fel ON email_mesaje (fel);
-- Scadenta taskurilor e o DATA, dar un raspuns "in 24 de ore" are si ora.
-- Data singura pierde pana la o zi intreaga din termen, exact la taskurile
-- unde termenul conteaza cel mai mult.
ALTER TABLE taskuri ADD COLUMN IF NOT EXISTS scadenta_la TEXT;
-- De unde vine o comanda si din ce email. O comanda nascuta dintr-un email
-- sta in ciorna pana o valideaza agentul, si atunci pleaca anuntul.
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS sursa TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS email_mesaj_id INTEGER;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS creata_de INTEGER;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS directie TEXT NOT NULL DEFAULT 'vanzare';
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS sursa_import TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS moneda TEXT DEFAULT 'RON';
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS total_valuta REAL;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS document_extern TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS index_spv TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS firma_id INTEGER;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS intercompany INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS agent_id INTEGER;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS agent_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS factura_id INTEGER;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS comanda_id INTEGER;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS data_livrare_ceruta TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS data_livrare_promisa TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS validata_de INTEGER;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS validata_la TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS creata_de INTEGER;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS notificare_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS notificari_oprite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS oferta_id INTEGER;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS contract_id INTEGER;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS agent_id INTEGER;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS utilizator_id INTEGER;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS task_id INTEGER;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS rezultat TEXT;
ALTER TABLE leaduri ADD COLUMN IF NOT EXISTS persoana_contact TEXT;
ALTER TABLE leaduri ADD COLUMN IF NOT EXISTS mod_contact TEXT;
ALTER TABLE leaduri ADD COLUMN IF NOT EXISTS motiv_sugestie TEXT;
ALTER TABLE alocari_clienti ADD COLUMN IF NOT EXISTS valabil_de_la TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS firma_grup_id INTEGER;
ALTER TABLE firme ADD COLUMN IF NOT EXISTS operationala INTEGER NOT NULL DEFAULT 1;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS comision_procent REAL NOT NULL DEFAULT 2;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS cost_masina_lunar REAL NOT NULL DEFAULT 0;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS masina_detalii TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS card_carburant TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS angajat_din TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS parola_temporara INTEGER NOT NULL DEFAULT 0;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS firma_angajare_id INTEGER;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS persoana_contact TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS stare TEXT NOT NULL DEFAULT 'client_activ';
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS sursa TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS agent_id INTEGER;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS reprezentant TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS caracteristici TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS um TEXT DEFAULT 'buc';
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS tip_ambalare TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS doc_emisa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS fisa_tehnica INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS data_livrare TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS data_nastere TEXT;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS utilizator_id INTEGER;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS lead_id INTEGER;
-- O interactiune poate fi legata de un lead care inca nu e partener (nu a fost
-- convertit in client). Coloana partener_id a fost creata obligatorie la inceput
-- cand interactiunile existau doar pe parteneri, iar asta bloca salvarea
-- interactiunilor pe lead-uri. O facem optionala.
ALTER TABLE interactiuni ALTER COLUMN partener_id DROP NOT NULL;
ALTER TABLE oportunitati ADD COLUMN IF NOT EXISTS atribuit_lui INTEGER;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS email_expeditor TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS email_semnatura TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS poza TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS activ INTEGER NOT NULL DEFAULT 1;
-- Ziua in care factura a fost inchisa ca istorie veche. Cat timp are valoare,
-- factura nu mai primeste plati la import si nu-si mai schimba statusul --
-- exact cerinta lui Vali: "daca in viitor apar incasari ptr facturi mai vechi
-- le ignori".
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS inchis_istoric TEXT;
ALTER TABLE plati ADD COLUMN IF NOT EXISTS activ INTEGER NOT NULL DEFAULT 1;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_parola_cifrata TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_securizare TEXT DEFAULT 'starttls';
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS firma_id INTEGER;
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS salariu_net REAL DEFAULT 0;
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS sediu TEXT;
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS activ INTEGER NOT NULL DEFAULT 1;
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS sursa TEXT;
ALTER TABLE angajati ADD COLUMN IF NOT EXISTS actualizat_la TEXT;
ALTER TABLE comenzi_linii ADD COLUMN IF NOT EXISTS cantitate_livrata REAL NOT NULL DEFAULT 0;
ALTER TABLE comenzi_linii ADD COLUMN IF NOT EXISTS stare TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS verificata_depozit_la TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS verificata_depozit_de TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS decizie_agent TEXT;
ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS motiv_anulare TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS aprovizionare_id INTEGER;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS produs_id INTEGER;

-- Registrul de comenzi ținut până acum în Excel are trei coloane pe care
-- tabela nu le avea: „Facturat" și variantele scrise ale lui DoC / Fișă
-- tehnică. Le ținem ca text, exact cum sunt scrise în registru (DA, Da, NA,
-- NU), fiindcă „NA" nu e nici da, nici nu — iar bifele 0/1 de mai sus nu
-- au unde s-o pună.
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS facturat TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS doc_emisa_txt TEXT;
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS fisa_tehnica_txt TEXT;

-- Agentul comenzii. Vine din codul scris în registru („IR", „GT"), tradus o
-- singură dată în omul din Utilizatori. De aici încolo comanda știe al cui e:
-- intră în pâlnia lui și în raportul lui, fără să mai citească nimeni inițiale.
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS agent_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_comenzi_productie_agent ON comenzi_productie (agent_id);

-- Codul agentului, așa cum e scris în registrul de comenzi. Inițialele se pot
-- ciocni (doi Mihai M.), deci codul se ține explicit pe om și se poate corecta
-- din fișa lui — nu se ghicește de fiecare dată din nume.
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS cod_agent TEXT;

-- Costul real al mărfii, luat din raportul „Profit pe produs" al
-- contabilității: cost ÷ vânzări nete, pe fiecare produs. Cu el, marja nu mai
-- depinde de un preț de achiziție static scris de mână, iar liniile fără preț
-- nu mai ies cu marjă 100%. Vezi lib/cost.js.
ALTER TABLE produse ADD COLUMN IF NOT EXISTS cost_rata REAL;
ALTER TABLE produse ADD COLUMN IF NOT EXISTS cost_rata_sursa TEXT;

-- FIFO in depozit. Paleta isi tine costul cu care a intrat, iar iesirea scrie
-- costul care a plecat efectiv din depozit. Fara cost la intrare, ordinea
-- „primul intrat, primul iesit" e doar o ordine, nu si o evaluare a consumului.
ALTER TABLE ct_paleti ADD COLUMN IF NOT EXISTS pret_unitar REAL;
ALTER TABLE ct_paleti ADD COLUMN IF NOT EXISTS pret_sursa TEXT;
ALTER TABLE ct_iesiri ADD COLUMN IF NOT EXISTS cost REAL;
ALTER TABLE ct_iesiri ADD COLUMN IF NOT EXISTS cost_temei TEXT;
ALTER TABLE ct_iesiri ADD COLUMN IF NOT EXISTS peste_rand TEXT;
-- De unde a venit paleta. Pana acum nu se scria nicaieri, iar la inventar
-- intrebarea "de la cine e marfa asta" nu avea raspuns fara sa cauti factura
-- de mana. Se tine si id-ul partenerului (cand e ales din nomenclator) si
-- textul scris liber, fiindca la intrare nu e mereu timp de cautat furnizorul.
ALTER TABLE ct_paleti ADD COLUMN IF NOT EXISTS furnizor_id INTEGER;
ALTER TABLE ct_paleti ADD COLUMN IF NOT EXISTS furnizor_text TEXT;
CREATE INDEX IF NOT EXISTS idx_ct_paleti_fifo ON ct_paleti (produs_id, data_intrare, id);

-- Costul unui produs finit, calculat din reteta lui: suma componentelor, la
-- cantitatea de pe o bucata. Se tine materializat pe produs ca sa poata fi
-- folosit direct in interogarile de marja. Vezi lib/cost.js.
ALTER TABLE produse ADD COLUMN IF NOT EXISTS cost_reteta REAL;
ALTER TABLE produse ADD COLUMN IF NOT EXISTS cost_reteta_lipsa INTEGER;
ALTER TABLE produse ADD COLUMN IF NOT EXISTS cost_reteta_la TEXT;
CREATE INDEX IF NOT EXISTS idx_retete_produs ON retete_componente (produs_id);

-- Registrul de comenzi n-are prețuri — e o listă de producție, nu una de
-- vânzare. Ca o comandă să poată intra în comisionul potențial, agentul îi
-- poate scrie o valoare estimată. Câmpul stă pe comandă, nu în tabelul din
-- listă: lista trebuie să rămână identică cu Excelul din care vine.
ALTER TABLE comenzi_productie ADD COLUMN IF NOT EXISTS valoare_estimata REAL;

-- Indexuri pe cheile străine folosite cel mai des. Fără ele, fiecare pagină
-- care calculează „cât e factura" si „cât s-a incasat pe ea" face cate o
-- parcurgere completa a tabelelor facturi_linii si plati pentru fiecare
-- factura in parte. La 8.000 de facturi asta inseamna sute de milioane de
-- randuri citite si pagini care se incarca in minute, nu in secunde.
CREATE INDEX IF NOT EXISTS idx_facturi_linii_factura ON facturi_linii (factura_id);
CREATE INDEX IF NOT EXISTS idx_plati_factura ON plati (factura_id);
CREATE INDEX IF NOT EXISTS idx_facturi_partener ON facturi (partener_id);
CREATE INDEX IF NOT EXISTS idx_facturi_data ON facturi (data_emiterii);
CREATE INDEX IF NOT EXISTS idx_facturi_directie ON facturi (directie);
CREATE INDEX IF NOT EXISTS idx_facturi_agent ON facturi (agent_id);
CREATE INDEX IF NOT EXISTS idx_plati_data ON plati (data);
CREATE INDEX IF NOT EXISTS idx_utilaje_capacitate_utilaj ON utilaje_capacitate (utilaj_id);
CREATE INDEX IF NOT EXISTS idx_utilaje_capacitate_produs ON utilaje_capacitate (produs_id);
CREATE INDEX IF NOT EXISTS idx_resurse_competente_resursa ON resurse_competente (resursa_id);
CREATE INDEX IF NOT EXISTS idx_resurse_competente_utilaj ON resurse_competente (utilaj_id);
CREATE INDEX IF NOT EXISTS idx_alocari_productie_comanda ON alocari_productie (comanda_productie_id);
CREATE INDEX IF NOT EXISTS idx_alocari_productie_utilaj ON alocari_productie (utilaj_id);
CREATE INDEX IF NOT EXISTS idx_alocari_productie_data ON alocari_productie (data);
CREATE INDEX IF NOT EXISTS idx_alocari_resurse_alocare ON alocari_resurse (alocare_id);
CREATE INDEX IF NOT EXISTS idx_alocari_resurse_resursa ON alocari_resurse (resursa_id);
CREATE INDEX IF NOT EXISTS idx_ct_locuri_rand ON ct_locuri (rand_id);
CREATE INDEX IF NOT EXISTS idx_ct_locuri_adresa ON ct_locuri (adresa);
CREATE INDEX IF NOT EXISTS idx_ct_ocupari_palet ON ct_ocupari (palet_id);
CREATE INDEX IF NOT EXISTS idx_ct_ocupari_loc ON ct_ocupari (loc_id);
CREATE INDEX IF NOT EXISTS idx_ct_paleti_iesire ON ct_paleti (data_iesire);

-- Amprenta randului din raportul de incasari din care a iesit plata.
--
-- Dedublarea veche se facea pe „factura + zi + suma". Nu tine: o incasare
-- poate lista mai multe facturi, iar suma se imparte intre ele proportional
-- cu soldul ramas. La al doilea import soldul e altul, deci si impartirea, si
-- aceeasi incasare intra a doua oara sub alte sume. Amprenta e a randului
-- SURSA (data + lista de facturi asa cum e scrisa + totalul incasarii), deci
-- nu se schimba oricat de des s-ar reimporta raportul.
ALTER TABLE plati ADD COLUMN IF NOT EXISTS amprenta TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS sectiuni TEXT;
CREATE INDEX IF NOT EXISTS idx_plati_amprenta ON plati (amprenta);
CREATE INDEX IF NOT EXISTS idx_ct_iesiri_palet ON ct_iesiri (palet_id);
CREATE INDEX IF NOT EXISTS idx_cereri_comision_om ON cereri_comision (utilizator_id, luna);
`;

// Sumele din balanțe au opt-nouă cifre, iar REAL în Postgres e float pe patru
// octeți: ține vreo șapte cifre semnificative, deci 12.112.691,20 se rotunjește
// la 12.112.691. Pe o factură nu se vede, pe o balanță se vede. Coloanele
// astea trec pe dublă precizie — separat, cu try, fiindcă harness-ul local pe
// SQLite nu cunoaște „ALTER COLUMN ... TYPE".
const COLOANE_DUBLE = [
  ["balante_snapshot", ["si_d", "si_c", "r_d", "r_c", "ts_d", "ts_c", "sf_d", "sf_c"]],
  ["inregistrari_contabile", ["debit", "credit"]],
];

async function largesteSume() {
  for (const [tabel, coloane] of COLOANE_DUBLE) {
    for (const c of coloane) {
      try {
        await exec(`ALTER TABLE ${tabel} ALTER COLUMN ${c} TYPE DOUBLE PRECISION`);
      } catch (e) {
        return; // SQLite local, sau deja schimbat — nu insistăm
      }
    }
  }
}

// Coloana „activ" a apărut peste niște tabele deja pline. Până nu trece
// ANALYZE peste ele, PostgreSQL n-are nicio statistică despre ea și
// presupune, din lipsă de altceva, că o egalitate pe o coloană necunoscută
// prinde 0,5% din rânduri. Cum toate interogările de facturi și de plăți trec
// acum printr-un „WHERE activ = 1", planificatorul crede că lucrează cu 40 de
// facturi în loc de 8.000 și alege nested loop peste tot — de unde pagini care
// se încarcă în minute, nu în secunde. ANALYZE la pornire e ieftin (tabelele
// sunt mici) și pune lucrurile la loc imediat, fără să așteptăm autovacuum.
async function actualizeazaStatistici() {
  for (const tabel of ["facturi", "plati", "facturi_linii"]) {
    try {
      await exec(`ANALYZE ${tabel}`);
    } catch (e) {
      return; // SQLite local sau lipsă de drepturi — nu blocăm pornirea
    }
  }
}

async function migrate() {
  await exec(SCHEMA);
  await exec(ALTERARI);
  await largesteSume();
  await actualizeazaStatistici();
}

module.exports = { prepare, exec, migrate, pool };
