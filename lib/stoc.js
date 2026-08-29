"use strict";
// Stocul curent, calculat corect dintr-un tabel care amestecă două feluri de
// rânduri.
//
// „miscari_stoc" ține și mișcări (intrare / ieșire), și inventare — fotografia
// stocului la o dată, adusă din balanța SmartBill. Un inventar NU e o mișcare:
// nu se adună la ce era înainte, ci înlocuiește tot. Formula veche
// (`intrare` adună, orice altceva scade) trata inventarul ca pe o ieșire și
// scădea fotografia din stoc — de aceea toate produsele apăreau cu stoc
// negativ, exact pe dos față de realitate.
//
// Aici stocul e: ultimul inventar al produsului în depozitul ăla, plus
// mișcările de DUPĂ el. Dacă produsul n-a fost inventariat niciodată, rămâne
// simpla diferență intrări minus ieșiri.
const SUB_STOC = `(SELECT m.produs_id, m.depozit_id,
                          SUM(CASE WHEN m.tip = 'inventar' THEN m.cantitate
                                   WHEN m.tip = 'intrare' THEN m.cantitate
                                   ELSE -m.cantitate END) AS stoc
                     FROM miscari_stoc m
                     LEFT JOIN (SELECT produs_id, depozit_id, MAX(data) AS data_inv
                                  FROM miscari_stoc WHERE tip = 'inventar'
                                 GROUP BY produs_id, depozit_id) i
                            ON i.produs_id = m.produs_id AND i.depozit_id = m.depozit_id
                    WHERE i.data_inv IS NULL
                       OR (m.tip = 'inventar' AND m.data = i.data_inv)
                       OR (m.tip <> 'inventar' AND m.data > i.data_inv)
                    GROUP BY m.produs_id, m.depozit_id)`;

// Același lucru, dar adunat pe produs, indiferent de depozit. Pentru forecast
// și pentru „am destul cât să acopăr luna viitoare?" nu contează unde stă
// marfa, ci dacă o avem.
const SUB_STOC_PRODUS = `(SELECT s.produs_id, SUM(s.stoc) AS stoc FROM ${SUB_STOC} s GROUP BY s.produs_id)`;

module.exports = { SUB_STOC, SUB_STOC_PRODUS };
