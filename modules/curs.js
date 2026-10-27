"use strict";
// Aducerea cursului BNR și cursul folosit de restul ERP-ului.
//
// Citirea fișierului și aritmetica sunt în lib/curs-bnr.js, cu testul lor.
// Aici e rețeaua și baza de date.
const db = require("../lib/db");
const B = require("../lib/curs-bnr");

const CURS_IMPLICIT = 5.25; // ce folosea Procurement înainte să existe BNR-ul

function azi() {
  return new Date().toISOString().slice(0, 10);
}

// Aduce fișierul BNR și scrie cursurile zilei.
//
// Nu aruncă niciodată. Un ERP care nu pornește fiindcă n-a răspuns site-ul
// BNR ar fi o glumă proastă — comenzile, stocul și facturile n-au nicio
// treabă cu cursul. Dacă nu merge, rămâne cursul de ieri.
async function adu() {
  try {
    const raspuns = await fetch(B.ADRESA, {
      headers: { "User-Agent": "ERP Cash Machine" },
      signal: AbortSignal.timeout(15000),
    });
    if (!raspuns.ok) return { ok: false, motiv: "BNR a răspuns cu " + raspuns.status };
    const corp = await raspuns.text();
    const r = B.parseaza(corp);
    if (!r) {
      // Ce anume a venit, scurtat. Fără asta, „n-a putut fi citit" nu spune
      // nimic: nu se știe dacă BNR a schimbat formatul, dacă a răspuns o
      // pagină de eroare, sau dacă e gol.
      const inceput = corp.replace(/\s+/g, " ").slice(0, 160);
      return { ok: false, motiv: `fișierul BNR n-a putut fi citit (${corp.length} octeți: ${inceput})` };
    }

    let scrise = 0;
    for (const [moneda, valoare] of Object.entries(r.cursuri)) {
      await db
        .prepare(
          `INSERT INTO cursuri_bnr (data, moneda, valoare) VALUES (?,?,?)
           ON CONFLICT (data, moneda) DO UPDATE SET valoare = EXCLUDED.valoare`
        )
        .run(r.data, moneda, valoare)
        .catch(() => null);
      scrise++;
    }
    return { ok: true, data: r.data, scrise };
  } catch (e) {
    return { ok: false, motiv: String((e && e.message) || e) };
  }
}

// Cursul unei monede la o zi anume.
//
// Dacă ziua aia nu există în bază (weekend, sărbătoare, sau cursul n-a fost
// adus încă), se ia ULTIMUL curs de dinaintea ei — exact cum face și
// contabilitatea: sâmbăta se lucrează cu cursul de vineri. Nu se ia cursul de
// după: ar însemna să folosim pe o comandă veche un curs care încă nu exista.
async function laZiua(moneda, data) {
  const m = String(moneda || "RON").toUpperCase();
  if (m === "RON") return { valoare: 1, data: data || azi(), sursa: "RON" };
  const r = await db
    .prepare("SELECT valoare, data FROM cursuri_bnr WHERE moneda = ? AND data <= ? ORDER BY data DESC LIMIT 1")
    .get(m, String(data || azi()))
    .catch(() => null);
  if (r && Number(r.valoare) > 0) return { valoare: Number(r.valoare), data: r.data, sursa: "BNR" };

  // Nimic în bază: cursul scris de mână în Procurement, dacă există. E o
  // cârjă, și se SPUNE că e o cârjă — de-aia `sursa` nu minte.
  const manual = await db
    .prepare("SELECT valoare FROM setari_app WHERE cheie = 'ach_curs_eur'")
    .get()
    .catch(() => null);
  const v = Number(String((manual && manual.valoare) || "").replace(",", "."));
  if (m === "EUR" && v > 0) return { valoare: v, data: "", sursa: "scris de mână" };
  if (m === "EUR") return { valoare: CURS_IMPLICIT, data: "", sursa: "implicit" };
  return { valoare: 0, data: "", sursa: "lipsă" };
}

// La pornire și o dată pe zi. Jobul care cheamă funcția asta e în server.js.
async function seed() {
  const r = await adu();
  if (r.ok) console.log(`[curs] BNR ${r.data}: ${r.scrise} monede`);
  else console.log(`[curs] nu am luat cursul BNR (${r.motiv}) — rămâne ce era`);
  return r;
}

function register(router) {
  const { send, redirect } = require("../lib/router");

  // Reîmprospătare la cerere, pentru administrator. Cursul se aduce oricum
  // singur, dar dimineața devreme BNR mai întârzie, iar omul care scrie o
  // comandă în euro la ora 9 n-are de ce să aștepte până mâine.
  router.post("/admin/curs-bnr", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const r = await adu();
    ctx.res.writeHead(r.ok ? 200 : 502, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify(r));
  });

  router.get("/admin/curs-bnr.json", async (ctx) => {
    if (!ctx.user) return send(ctx.res, 403, "{}");
    const eur = await laZiua("EUR", azi());
    const usd = await laZiua("USD", azi());
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ EUR: eur, USD: usd }));
  });
}

module.exports = { adu, laZiua, seed, register, CURS_IMPLICIT };
