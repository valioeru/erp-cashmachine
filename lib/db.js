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
  partener_id INTEGER NOT NULL REFERENCES parteneri(id),
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
`;

// Coloane adăugate ulterior primei versiuni a schemei. "CREATE TABLE IF NOT
// EXISTS" de mai sus nu modifică un tabel deja existent pe o bază de date
// live — de-aia coloanele noi se adaugă separat, idempotent, cu ALTER TABLE
// ... ADD COLUMN IF NOT EXISTS (sigur de rulat de fiecare dată la pornire).
const ALTERARI = `
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS directie TEXT NOT NULL DEFAULT 'vanzare';
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS sursa_import TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS moneda TEXT DEFAULT 'RON';
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS total_valuta REAL;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS document_extern TEXT;
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS index_spv TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS persoana_contact TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS stare TEXT NOT NULL DEFAULT 'client_activ';
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS sursa TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS agent_id INTEGER;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS data_nastere TEXT;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS utilizator_id INTEGER;
ALTER TABLE interactiuni ADD COLUMN IF NOT EXISTS lead_id INTEGER;
ALTER TABLE oportunitati ADD COLUMN IF NOT EXISTS atribuit_lui INTEGER;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS email_expeditor TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS email_semnatura TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_parola_cifrata TEXT;
ALTER TABLE utilizatori ADD COLUMN IF NOT EXISTS smtp_securizare TEXT DEFAULT 'starttls';
`;

async function migrate() {
  await exec(SCHEMA);
  await exec(ALTERARI);
}

module.exports = { prepare, exec, migrate, pool };
