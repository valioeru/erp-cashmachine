"use strict";
// Butonul „+ Furnizor nou" de pe comanda către furnizor.
//
// CE S-A STRICAT (raportat de Vali, 28.10.2026): „apeși butonul furnizor nou,
// dispare butonul și nu se întâmplă nimic."
//
// Nu era stricat codul care deschide formularul — formularul CHIAR se
// deschidea. Dar butonul stă sus, lângă lista de furnizori, iar formularul e
// ultimul lucru din pagină, fiindcă două formulare nu se pot imbrica în HTML.
// Măsurat: se deschidea la 1020 px, într-o fereastră de 800. Pagina nu se
// mișca. Deci singurul lucru vizibil era butonul care dispare.
//
// Și al doilea, mai urât: „Închide" ascundea formularul, dar nu aducea
// butonul înapoi. După o închidere nu se mai putea adăuga niciun furnizor
// fără reîncărcarea paginii.
//
// Testul se uită la HTML-ul randat, nu la ecran: dacă cineva scoate
// derularea sau revenirea butonului, cade aici, nu peste trei luni în
// telefon.

const assert = require("assert");
const path = require("path");
const Module = require("module");

let treceri = 0;
function test(nume, f) {
  f();
  treceri++;
  console.log("  ok —", nume);
}

function pune(cale, exporturi) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = exporturi;
  require.cache[abs] = m;
}

const FURNIZORI = [{ id: 1, nume: "FURNIZOR DE PROBĂ SRL", email: "of@x.ro" }];
const PRODUSE = [{ id: 1, cod: "P1", denumire: "Produs", unitate_masura: "buc", categorie: "Folie" }];
pune("./lib/db", {
  prepare: (sql) => ({
    all: async () => (/FROM parteneri/i.test(sql) ? FURNIZORI : /FROM produse/i.test(sql) ? PRODUSE : []),
    get: async () => null,
    run: async () => ({ lastInsertRowid: 1 }),
  }),
  exec: async () => {},
});

const mod = require("./modules/comenzi-furnizor");
const rute = { get: new Map(), post: new Map() };
mod.register({ get: (c, f) => rute.get.set(c, f), post: (c, f) => rute.post.set(c, f) });

(async () => {
  const res = { cod: 0, antete: {}, writeHead(c, h) { this.cod = c; Object.assign(this.antete, h || {}); }, end(b) { this.corp = b; } };
  await rute.get.get("/procurement/comenzi/noua")({
    res, query: {}, params: {}, body: {}, user: { id: 1, rol: "admin", nume: "Vali" }, req: { headers: {}, url: "/" },
  });
  const html = String(res.corp);

  test("pagina se randează", () => {
    assert.strictEqual(res.cod, 200);
    assert.ok(html.includes("Furnizor nou"));
  });

  test("butonul are id și cheamă funcția, nu un onclick scris în linie", () => {
    assert.ok(html.includes('id="cf-buton-furnizor-nou"'), "butonul trebuie să aibă id, ca să poată fi adus înapoi");
    assert.ok(html.includes("cfDeschideFurnizor()"), "butonul trebuie să cheme funcția de deschidere");
    // Vechiul onclick ascundea butonul fără să deruleze nicăieri.
    assert.ok(
      !/onclick="document\.getElementById\('cf-furnizor-nou'\)\.style\.display='block';this\.style\.display='none'"/.test(html),
      "s-a întors onclick-ul vechi, cel care doar ascundea butonul"
    );
  });

  test("deschiderea derulează la formular — altfel se deschide sub ecran", () => {
    const f = (html.match(/function cfDeschideFurnizor\(\)[\s\S]*?\n      \}/) || [""])[0];
    assert.ok(f, "funcția de deschidere lipsește");
    assert.ok(/scrollIntoView/.test(f), "fără scrollIntoView, bugul se întoarce exact cum a fost raportat");
    assert.ok(/display\s*=\s*"block"/.test(f), "formularul trebuie arătat");
    assert.ok(/focus\(\)/.test(f), "focusul pe primul câmp arată omului unde a ajuns");
  });

  test("închiderea aduce butonul înapoi", () => {
    const f = (html.match(/function cfInchideFurnizor\(\)[\s\S]*?\n      \}/) || [""])[0];
    assert.ok(f, "funcția de închidere lipsește");
    assert.ok(/buton\.style\.display\s*=\s*""/.test(f), "butonul trebuie readus, altfel pagina rămâne fără el până la reîncărcare");
    assert.ok(!/this\.closest\("?'?form/.test(f), "închiderea nu se mai face din onclick pe formular");
  });

  test("butonul „Închide” cheamă funcția, nu ascunde formularul direct", () => {
    assert.ok(html.includes("cfInchideFurnizor()"));
    assert.ok(
      !html.includes("onclick=\"this.closest('form').style.display='none'\""),
      "s-a întors închiderea veche, care lăsa butonul ascuns pentru totdeauna"
    );
  });

  test("formularul de furnizor NU e imbricat în cel de comandă", () => {
    // Două formulare imbricate sunt HTML nevalid: browserul îl aruncă pe cel
    // dinăuntru, iar câmpurile lui ar pleca odată cu comanda.
    const iComanda = html.indexOf('action="/procurement/comenzi"');
    const iFurnizor = html.indexOf('id="cf-furnizor-nou"');
    const iInchidereComanda = html.indexOf("</form>", iComanda);
    assert.ok(iComanda > -1 && iFurnizor > -1, "lipsește unul dintre formulare");
    assert.ok(iFurnizor > iInchidereComanda, "formularul de furnizor a intrat în cel de comandă");
  });

  test("scrie pe față că pozițiile se pierd la salvarea furnizorului", () => {
    // Formularul se trimite separat, deci pagina se reîncarcă. Fără nota
    // asta, omul scrie zece poziții și le pierde fără să înțeleagă de ce.
    assert.ok(/pozițiile scrise sus se pierd/i.test(html));
  });

  console.log(`\n${treceri} verificări trecute.`);
})().catch((e) => {
  console.error("\nCĂZUT:", e.message);
  process.exit(1);
});
