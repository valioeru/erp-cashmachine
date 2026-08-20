"use strict";
const db = require("./db");

async function seedIfEmpty() {
  const nrParteneri = (await db.prepare("SELECT COUNT(*) AS n FROM parteneri").get()).n;
  if (nrParteneri > 0) return false;

  const insP = db.prepare("INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa) VALUES (?, ?, ?, ?, ?, ?) RETURNING id");
  const p1 = (await insP.run("client", "Alfa Distribuție SRL", "RO11111111", "contact@alfa.ro", "0722111111", "Str. Exemplu nr. 1, București")).lastInsertRowid;
  await insP.run("client", "Beta Retail SRL", "RO22222222", "office@beta.ro", "0733222222", "Str. Exemplu nr. 2, Cluj-Napoca");
  await insP.run("furnizor", "Gamma Furnizori SRL", "RO33333333", "vanzari@gamma.ro", "0744333333", "Str. Exemplu nr. 3, Iași");

  const insProd = db.prepare(
    "INSERT INTO produse (cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, cota_tva, stoc_minim) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  );
  const prod1 = (await insProd.run("PRD-001", "Laptop Office 14\"", "buc", 3200, 2600, 19, 3)).lastInsertRowid;
  const prod2 = (await insProd.run("PRD-002", "Monitor 24\"", "buc", 850, 650, 19, 5)).lastInsertRowid;
  const prod3 = (await insProd.run("PRD-003", "Mouse wireless", "buc", 65, 40, 19, 10)).lastInsertRowid;

  const insDep = db.prepare("INSERT INTO depozite (denumire, locatie) VALUES (?, ?) RETURNING id");
  const dep1 = (await insDep.run("Depozit central", "București")).lastInsertRowid;

  const insMisc = db.prepare(
    "INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, observatii) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  await insMisc.run(prod1, dep1, "intrare", 10, 2600, "NIR 1", "Stoc inițial");
  await insMisc.run(prod2, dep1, "intrare", 15, 650, "NIR 1", "Stoc inițial");
  await insMisc.run(prod3, dep1, "intrare", 40, 40, "NIR 1", "Stoc inițial");
  await insMisc.run(prod1, dep1, "iesire", 2, 3200, "Comandă demo", "");

  const insAng = db.prepare(
    "INSERT INTO angajati (nume, functie, departament, email, telefon, data_angajarii, salariu_baza) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  await insAng.run("Ana Popescu", "Contabil", "Financiar", "ana.popescu@compania.ro", "0755111111", "2022-03-01", 6500);
  await insAng.run("Mihai Ionescu", "Agent vânzări", "Vânzări", "mihai.ionescu@compania.ro", "0755222222", "2023-06-15", 5200);

  const insCom = db.prepare("INSERT INTO comenzi (partener_id, numar, status, observatii) VALUES (?, ?, ?, ?) RETURNING id");
  const comId = (await insCom.run(p1, "CMD-0001", "confirmata", "Comandă demonstrativă")).lastInsertRowid;
  const insComLinie = db.prepare("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, ?)");
  await insComLinie.run(comId, prod1, 2, 3200);
  await insComLinie.run(comId, prod3, 5, 65);

  console.log("Date demonstrative inserate: parteneri, produse, depozit, mișcări de stoc, angajați, comandă.");
  return true;
}

if (require.main === module) {
  seedIfEmpty()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { seedIfEmpty };
