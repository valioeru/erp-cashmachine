-- Depozitul de test, refăcut de la zero la fiecare rulare, ca testul să dea
-- același rezultat oricâte ori îl rulezi.
--
-- Rândul 3: 5 niveluri × 4 câmpuri. Nivelul 1 e „paleți înalți" (2,2 m, doar
-- 2 paleți pe câmp), nivelul 5 e „cutii ușoare" (1,2 m). Restul moștenesc
-- cifrele rândului. Rândul 5: 4 niveluri × 3 câmpuri, toate la fel.
-- Trei paleți în depozit: unul lat (stă pe 3 locuri), doi normali.
TRUNCATE ct_ocupari, ct_iesiri, ct_locuri, ct_niveluri, ct_paleti, ct_randuri RESTART IDENTITY CASCADE;
DELETE FROM facturi_linii;
DELETE FROM facturi;
DELETE FROM produse;
-- Tot ce atarna de parteneri pleaca inainte: aplicatia isi creeaza singura
-- leaduri si contacte din parteneri (vezi sugestiile din CRM si Marketing),
-- iar cheile straine ar bloca stergerea si fixtura n-ar mai fi repetabila.
DELETE FROM mk_contacte_istoric;
DELETE FROM mk_aniversari;
DELETE FROM mk_contacte;
DELETE FROM leaduri;
DELETE FROM interactiuni;
DELETE FROM oportunitati;
DELETE FROM parteneri;

INSERT INTO parteneri (id, tip, nume) VALUES
  (1,'furnizor','TERAPLAST RECYCLING SA'),(2,'furnizor','ROMTEXTIL SA'),(3,'client','CARGUS S.R.L.');
INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
  (1,'GR-LLDPE','Granulă LLDPE natur','kg'),(2,'CUT-820','Cutie carton 820x160x820','buc');
INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii) VALUES
  (1,'F',100,1,'achizitie','2026-03-10'),(2,'F',200,2,'achizitie','2026-07-02'),(3,'F',300,1,'achizitie','2026-08-20');
INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar) VALUES
  (1,1,'Granulă LLDPE',1000,6.5),(3,1,'Granulă LLDPE',2000,6.8),(2,2,'Cutie carton',500,6.2);

INSERT INTO ct_randuri (id, numar, eticheta, niveluri, campuri, locuri_pe_camp, latime_loc, adancime_loc, inaltime_nivel, activ)
  VALUES (1,3,'materie primă',5,4,3,900,1100,1800,1),
         (2,5,'produse finite',4,3,3,900,1100,1800,1);
INSERT INTO ct_niveluri (rand_id, nivel, inaltime, eticheta, locuri_pe_camp) VALUES
  (1,1,2200,'paleți înalți',2),
  (1,5,1200,'cutii ușoare',3);

INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa)
SELECT 1, n.nivel, c.camp, p.pozitie,
       'R3-' || lpad(c.camp::text,2,'0') || '-' || n.nivel || '-' || p.pozitie
  FROM generate_series(1,5) n(nivel) CROSS JOIN generate_series(1,4) c(camp) CROSS JOIN generate_series(1,3) p(pozitie)
 WHERE p.pozitie <= CASE WHEN n.nivel = 1 THEN 2 ELSE 3 END;
INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa)
SELECT 2, n.nivel, c.camp, p.pozitie,
       'R5-' || lpad(c.camp::text,2,'0') || '-' || n.nivel || '-' || p.pozitie
  FROM generate_series(1,4) n(nivel) CROSS JOIN generate_series(1,3) c(camp) CROSS JOIN generate_series(1,3) p(pozitie);

INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, lot, categorie, data_intrare, pret_unitar, pret_sursa, furnizor_id)
  VALUES (1,'',1,1200,'kg','L-2026-08','materie primă','2026-08-14 09:12:00',6.8,'factura F300',1);
INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, categorie, data_intrare, pret_unitar)
  VALUES (2,'',2,400,'buc','produse finite','2026-09-02 11:00:00',6.26);
INSERT INTO ct_paleti (id, cod, produs_text, cantitate, um, categorie, data_intrare)
  VALUES (3,'','folie stretch 23µ',300,'kg','produse finite','2026-09-10 08:30:00');

INSERT INTO ct_ocupari (palet_id, loc_id) SELECT 1, id FROM ct_locuri WHERE rand_id=1 AND nivel=2 AND camp=1 AND pozitie IN (1,2,3);
INSERT INTO ct_ocupari (palet_id, loc_id) SELECT 2, id FROM ct_locuri WHERE rand_id=2 AND nivel=1 AND camp=1 AND pozitie=1;
INSERT INTO ct_ocupari (palet_id, loc_id) SELECT 3, id FROM ct_locuri WHERE rand_id=2 AND nivel=3 AND camp=2 AND pozitie=2;

SELECT setval(pg_get_serial_sequence('parteneri','id'), 10);
SELECT setval(pg_get_serial_sequence('produse','id'), 10);
SELECT setval(pg_get_serial_sequence('facturi','id'), 10);
SELECT setval(pg_get_serial_sequence('ct_randuri','id'), 10);
SELECT setval(pg_get_serial_sequence('ct_paleti','id'), 10);
