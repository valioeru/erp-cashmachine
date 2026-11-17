"use strict";
// Prețul scris în lei sau în valută (lib/pret-valuta.js). Fără bază de date.
//
// CE A CERUT VALI, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se
// schimbă — la marfa intrată în stoc sau oriunde."
//
// CE APĂRĂ:
//   • lei → nimic de făcut; valută cu cursul gol → BNR-ul zilei; curs scris →
//     al omului; curs greșit, monedă necunoscută sau BNR mut → refuz, cu mesaj.
//   • prețul în lei are șase zecimale; nota de lângă el spune din ce s-a făcut.
//   • câmpul din pagină: arată cursul doar la valută, propune BNR-ul, scrie cât
//     face prețul în lei.
const path = require("path");
const PV = require(path.join(__dirname, "lib", "pret-valuta.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

(async () => {
  const B = { valoare: 5.0912, data: "2026-11-17" };

  console.log("1. Ce a ales omul");
  egal("lei, orice ar fi în câmpul de curs", [PV.alege({ moneda: "RON", curs: "abc", bnr: B }), PV.alege({ moneda: "", curs: "5" }), PV.alege({}), PV.alege()], [PV.LEI, PV.LEI, PV.LEI, PV.LEI]);
  egal("euro, cursul gol → BNR-ul zilei, cu data lui", PV.alege({ moneda: "EUR", curs: "", bnr: B }), { ok: true, moneda: "EUR", curs: 5.0912, data: "2026-11-17", manual: 0 });
  egal("euro, curs scris → exact acela, al omului, fără dată BNR", PV.alege({ moneda: "eur", curs: "5,25", bnr: B }), { ok: true, moneda: "EUR", curs: 5.25, data: null, manual: 1 });
  egal("scris la fel ca BNR-ul → rămâne BNR", PV.alege({ moneda: "EUR", curs: "5,0912", bnr: B }), { ok: true, moneda: "EUR", curs: 5.0912, data: "2026-11-17", manual: 0 });
  egal("curs scris, fără BNR → al omului", PV.alege({ moneda: "USD", curs: "4.6", bnr: null }), { ok: true, moneda: "USD", curs: 4.6, data: null, manual: 1 });
  const faraBnr = PV.alege({ moneda: "EUR", curs: "", bnr: null });
  bine("cursul gol și BNR-ul mut → refuz, cu cererea de a scrie cursul; nimic ghicit", faraBnr.ok === false && /BNR nu are acum curs pentru EUR/.test(faraBnr.eroare) && faraBnr.curs === undefined, JSON.stringify(faraBnr));
  egal("un BNR fără valoare e tot mut", PV.alege({ moneda: "EUR", curs: "", bnr: { valoare: 0, data: "2026-11-17" } }).ok, false);
  for (const x of ["cinci", "-1", "0", "5,09,1"]) {
    const r = PV.alege({ moneda: "EUR", curs: x, bnr: B });
    bine(`cursul „${x}” e refuzat, cu mesajul cursului`, r.ok === false && r.eroare === PV.MESAJ_CURS, JSON.stringify(r));
  }
  const gbp = PV.alege({ moneda: "GBP", curs: "6", bnr: B });
  bine("o monedă necunoscută e refuzată, nu luată drept lei", gbp.ok === false && /GBP/.test(gbp.eroare), JSON.stringify(gbp));
  egal("moneda din formular: gol = lei, litere mici, necunoscută = null", [PV.moneda(""), PV.moneda(undefined), PV.moneda(" eur "), PV.moneda("usd"), PV.moneda("GBP")], ["RON", "RON", "EUR", "USD", null]);

  console.log("\n2. Din formular, cu BNR-ul cerut doar la nevoie");
  let cereri = [];
  const laZiua = async (m, zi) => { cereri.push(m + " " + zi); return m === "EUR" ? B : null; };
  egal("lei: BNR-ul nu se întreabă", [await PV.dinFormular({ pret_moneda: "RON", pret_curs: "9" }, laZiua), await PV.dinFormular({}, laZiua), await PV.dinFormular(null, laZiua), cereri.length], [PV.LEI, PV.LEI, PV.LEI, 0]);
  egal("euro: se întreabă pentru azi", [await PV.dinFormular({ pret_moneda: "EUR", pret_curs: "" }, laZiua), cereri], [{ ok: true, moneda: "EUR", curs: 5.0912, data: "2026-11-17", manual: 0 }, ["EUR " + new Date().toISOString().slice(0, 10)]]);
  egal("dolari, BNR-ul n-are: se cere cursul", (await PV.dinFormular({ pret_moneda: "USD" }, laZiua)).ok, false);
  egal("dolari, cu cursul scris: merge și fără BNR", await PV.dinFormular({ pret_moneda: "USD", pret_curs: "4,6034" }, laZiua), { ok: true, moneda: "USD", curs: 4.6034, data: null, manual: 1 });
  egal("BNR-ul care crapă e ca unul mut", [(await PV.dinFormular({ pret_moneda: "EUR" }, async () => { throw new Error("jos"); })).ok, (await PV.dinFormular({ pret_moneda: "EUR", pret_curs: "5" }, async () => { throw new Error("jos"); })).curs, (await PV.dinFormular({ pret_moneda: "EUR", pret_curs: "5" })).curs], [false, 5, 5]);
  egal("moneda necunoscută nu ajunge la BNR", [(await PV.dinFormular({ pret_moneda: "GBP" }, laZiua)).ok, cereri.length], [false, 3]);

  console.log("\n3. Prețul în lei și nota de lângă el");
  const E = PV.alege({ moneda: "EUR", curs: "", bnr: B });
  const M = PV.alege({ moneda: "EUR", curs: "5,25", bnr: B });
  egal("în lei, la cursul ales, cu șase zecimale", [PV.inLei(1.25, E), PV.inLei(0.03, E), PV.inLei(1.25, M), PV.inLei(0.16005, E)], [6.364, 0.152736, 6.5625, 0.814847]);
  egal("…sau cu câte se cer", [PV.inLei(0.16005, E, 4), PV.inLei(0.16005, E, 2)], [0.8148, 0.81]);
  egal("lei: prețul rămâne cum e, cu toate zecimalele lui", [PV.inLei(7.3512345, PV.LEI), PV.inLei(7.35, null), PV.inLei("7.35", { moneda: "RON" })], [7.3512345, 7.35, 7.35]);
  egal("ce nu e număr, sau valută fără curs: nimic", [PV.inLei("abc", E), PV.inLei(1, { moneda: "EUR", curs: null }), PV.inLei(1, { moneda: "EUR", curs: 0 })], [null, null, null]);
  egal("nota: prețul, moneda, cursul și de unde e", [PV.nota(1.25, E), PV.nota(1.25, M), PV.nota(0.03, PV.alege({ moneda: "USD", curs: "4,603412" }))],
    ["1,25 EUR × 5,0912 (BNR din 17.11.2026)", "1,25 EUR × 5,2500 (curs pus de voi)", "0,03 USD × 4,603412 (curs pus de voi)"]);
  egal("BNR fără zi: doar „BNR”", PV.nota(2, { moneda: "EUR", curs: 5, data: null, manual: 0 }), "2 EUR × 5,0000 (BNR)");
  egal("lei: nicio notă", [PV.nota(7.35, PV.LEI), PV.nota(7.35, null), PV.deUnde(PV.LEI), PV.nota("x", E), PV.nota(1, { moneda: "EUR", curs: null })], ["", "", "", "", ""]);
  egal("sursa prețului, cu nota lipită", [PV.sursa("scris la intrare", 1.25, E), PV.sursa("scris la intrare", 7.35, PV.LEI)], ["scris la intrare: 1,25 EUR × 5,0912 (BNR din 17.11.2026)", "scris la intrare"]);
  egal("e în lei?", [PV.eLei(PV.LEI), PV.eLei(null), PV.eLei({}), PV.eLei(E)], [true, true, true, false]);

  console.log("\n4. Câmpul din pagină");
  const c0 = PV.camp({});
  bine("implicit lei, cu cele trei monede, cursul ascuns", c0.includes('name="pret_moneda"') && c0.includes('<option value="RON" selected>lei (RON)</option>') && c0.includes('<option value="EUR">EUR</option>') && c0.includes('<option value="USD">USD</option>') && /data-pv-curs style="margin:0;display:none"/.test(c0) && c0.includes('name="pret_curs" value=""'));
  const c1 = PV.camp({ pret_moneda: "eur", pret_curs: ' 5,25"><x ' });
  bine("întors cu ce era scris: moneda aleasă, cursul la vedere și scăpat", c1.includes('<option value="EUR" selected>EUR</option>') && /data-pv-curs style="margin:0"/.test(c1) && c1.includes('value="5,25&quot;&gt;&lt;x"') && !c1.includes("<x"));
  bine("o monedă necunoscută se arată ca lei", PV.camp({ pret_moneda: "GBP" }).includes('<option value="RON" selected>'));
  bine("eticheta și varianta pe un rând", PV.camp({}, { eticheta: "Moneda <prețului>", compact: true, clasa: "sc-f" }).includes("Moneda &lt;prețului&gt;") && PV.camp({}, { compact: true, clasa: "sc-f" }).includes('class="sc-f"') && PV.camp({}, { compact: true }).includes("display:flex"));
  egal("câmpurile ascunse duc alegerea prin pașii de confirmare", [PV.ascunse({ pret_moneda: "EUR", pret_curs: " 5,25 " }), PV.ascunse({ pret_moneda: "RON", pret_curs: "5" }), PV.ascunse({}), PV.ascunse({ pret_moneda: "GBP" }), PV.ascunse({ pret_moneda: "usd", pret_curs: '"' })],
    ['<input type="hidden" name="pret_moneda" value="EUR"><input type="hidden" name="pret_curs" value="5,25">', "", "", "", '<input type="hidden" name="pret_moneda" value="USD"><input type="hidden" name="pret_curs" value="&quot;">']);
  const sc = PV.script({ EUR: B, USD: { valoare: 4.6034, data: "2026-11-17" } });
  bine("scriptul poartă BNR-ul zilei și nu poate fi rupt de un text", sc.includes('"EUR":{"valoare":5.0912,"data":"2026-11-17"}') && !PV.script({ EUR: { valoare: 1, data: "</script><b>" } }).includes("</script><b>"));
  egal("BNR-ul de azi, pe monede; ce lipsește sau crapă nu apare", [await PV.bnrAzi(async (m) => (m === "EUR" ? B : m === "USD" ? { valoare: 0 } : null)), await PV.bnrAzi(async () => { throw new Error("jos"); }), await PV.bnrAzi()], [{ EUR: { valoare: 5.0912, data: "2026-11-17" } }, {}, {}]);

  console.log("\n5. În browser: câmpul se poartă cum scrie pe el");
  let pw = null;
  try { pw = require("playwright"); } catch (_) { pw = null; }
  if (!pw) console.log("  (fără Playwright aici — sar peste)");
  else {
    const b = await pw.chromium.launch();
    const p = await b.newPage();
    const erori = [];
    p.on("pageerror", (e) => erori.push(e.message));
    const html = (valori) => `<!doctype html><html><body><form>${PV.camp(valori)}
      <label>Preț de intrare (<span data-pv-um>lei</span> / kg)<input name="pret_unitar" data-pv-pret value=""></label>
      <label>Alt preț<input name="pret_2" data-pv-pret value="2"></label></form>${PV.script({ EUR: B })}</body></html>`;
    await p.setContent(html({}));
    const stare = () => p.evaluate(() => ({
      curs: getComputedStyle(document.querySelector("[data-pv-curs]")).display !== "none",
      nota: document.querySelector("[data-pv-nota]").textContent,
      notaLaVedere: getComputedStyle(document.querySelector("[data-pv-nota]")).display !== "none",
      um: document.querySelector("[data-pv-um]").textContent,
      m: document.querySelector("[data-pv-m]").textContent,
      loc: document.querySelector("[data-pv-valoare]").placeholder,
      valoare: document.querySelector("[data-pv-valoare]").value,
      egal: [...document.querySelectorAll("[data-pv-egal]")].map((e) => e.textContent),
    }));
    let s = await stare();
    egal("în lei: cursul și nota ascunse, eticheta spune „lei”, niciun rând de lei lângă prețuri", [s.curs, s.notaLaVedere, s.um, s.egal], [false, false, "lei", []]);
    await p.selectOption("[data-pv-moneda]", "EUR");
    s = await stare();
    egal("pe euro: apare cursul, cu BNR-ul propus în câmpul gol; eticheta spune „EUR”", [s.curs, s.notaLaVedere, s.um, s.m, s.loc, s.valoare], [true, true, "EUR", "EUR", "5,0912", ""]);
    bine("…nota spune BNR-ul, ziua și că golul înseamnă BNR", s.nota.startsWith("BNR din 17.11.2026: 5,0912 · lăsat gol, se ia BNR-ul.") && s.nota.includes("așa rămâne"), s.nota);
    egal("…iar prețul deja scris își arată leii; cel gol, nimic", s.egal, ["= 10,1824 lei"]);
    await p.fill('input[name="pret_unitar"]', "1,25");
    s = await stare();
    egal("prețul scris în euro arată pe loc cât face în lei, la BNR", s.egal, ["= 6,3640 lei", "= 10,1824 lei"]);
    await p.fill("[data-pv-valoare]", "5,25");
    s = await stare();
    egal("cu cursul vostru: leii se refac", s.egal, ["= 6,5625 lei", "= 10,5000 lei"]);
    bine("…și nota spune cu cât diferă de BNR", s.nota.includes("cursul vostru diferă cu +3,12%"), s.nota);
    await p.fill("[data-pv-valoare]", "cinci");
    s = await stare();
    bine("un curs care nu e număr: nota o spune și nu se arată lei inventați", s.nota.includes("cursul scris nu e un număr") && s.egal.every((x) => x === ""), JSON.stringify(s));
    await p.selectOption("[data-pv-moneda]", "USD");
    s = await stare();
    bine("pe dolari, fără BNR: cursul vechi se șterge, nota cere cursul, fără lei ghiciți", s.valoare === "" && s.loc === "" && s.nota.startsWith("BNR nu are acum curs pentru USD — scrie-l tu") && s.um === "USD" && s.egal.every((x) => x === ""), JSON.stringify(s));
    await p.selectOption("[data-pv-moneda]", "RON");
    s = await stare();
    egal("înapoi pe lei: totul se ascunde la loc", [s.curs, s.notaLaVedere, s.um, s.egal], [false, false, "lei", ["", ""]]);
    await p.setContent(html({ pret_moneda: "EUR", pret_curs: "5,3" }));
    s = await stare();
    egal("pagina întoarsă cu euro și cursul scris: le arată din prima", [s.curs, s.valoare, s.um, s.egal], [true, "5,3", "EUR", ["= 10,6000 lei"]]);
    // Lista cu câte un formular mic pe rând: alegerea de deasupra ajunge în fiecare.
    await p.setContent(`<!doctype html><html><body>${PV.camp({})}
      <form id="f1"><input type="hidden" name="pret_moneda" data-pv-copie="moneda" value=""><input type="hidden" name="pret_curs" data-pv-copie="curs" value=""><input name="pret" data-pv-pret></form>
      <form id="f2"><input type="hidden" name="pret_moneda" data-pv-copie="moneda" value=""><input type="hidden" name="pret_curs" data-pv-copie="curs" value=""><input name="pret" data-pv-pret></form>
      ${PV.script({ EUR: B })}</body></html>`);
    const copii = () => p.evaluate(() => ["f1", "f2"].map((f) => [document.querySelector("#" + f + ' [name="pret_moneda"]').value, document.querySelector("#" + f + ' [name="pret_curs"]').value, (document.querySelector("#" + f + " [data-pv-egal]") || {}).textContent || ""]));
    egal("lista: la început, fiecare formular e pe lei", await copii(), [["RON", "", ""], ["RON", "", ""]]);
    await p.selectOption("[data-pv-moneda]", "EUR");
    await p.fill("[data-pv-valoare]", "5,2");
    await p.fill('#f2 [name="pret"]', "2");
    egal("lista: moneda și cursul alese deasupra ajung în fiecare formular, iar leii apar lângă prețul scris", await copii(), [["EUR", "5,2", ""], ["EUR", "5,2", "= 10,4000 lei"]]);
    await p.selectOption("[data-pv-moneda]", "RON");
    egal("lista: înapoi pe lei, cursul nu mai pleacă", await copii(), [["RON", "", ""], ["RON", "", ""]]);
    egal("fără erori de script în pagină", erori, []);
    await b.close();
  }

  console.log(esecuri ? `\n${esecuri} ESEC(URI)` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
