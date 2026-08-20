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
  data_emiterii TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  data_scadenta TEXT,
  status TEXT NOT NULL DEFAULT 'emisa',
  observatii TEXT,
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
`;

async function migrate() {
  await exec(SCHEMA);
}

module.exports = { prepare, exec, migrate, pool };
