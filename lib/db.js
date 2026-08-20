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
`;

// Coloane adăugate ulterior primei versiuni a schemei. "CREATE TABLE IF NOT
// EXISTS" de mai sus nu modifică un tabel deja existent pe o bază de date
// live — de-aia coloanele noi se adaugă separat, idempotent, cu ALTER TABLE
// ... ADD COLUMN IF NOT EXISTS (sigur de rulat de fiecare dată la pornire).
const ALTERARI = `
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS directie TEXT NOT NULL DEFAULT 'vanzare';
ALTER TABLE facturi ADD COLUMN IF NOT EXISTS sursa_import TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS persoana_contact TEXT;
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS stare TEXT NOT NULL DEFAULT 'client_activ';
ALTER TABLE parteneri ADD COLUMN IF NOT EXISTS sursa TEXT;
`;

async function migrate() {
  await exec(SCHEMA);
  await exec(ALTERARI);
}

module.exports = { prepare, exec, migrate, pool };
