"use strict";
// Rutele zonei de fișier de planificare lunară, rulate fără bază de date.
//
// Nu se poate instala `pg` aici, deci baza se înlocuiește cu una de hârtie:
// un `lib/db` fals pus în require.cache înainte ca modulul să fie încărcat.
// Verificăm ce CERE codul de la bază și ce răspunde omului — adică exact
// partea care se poate strica fără să se vadă în teste pure.

const assert = require("assert");
const path = require("path");
const Module = require("module");

let treceri = 0;
function test(nume, f) {
  const r = f();
  const gata = () => {
    treceri++;
    console.log("  ok —", nume);
  };
  return r && typeof r.then === "function" ? r.then(gata) : (gata(), Promise.resolve());
}

// ---- baza de hârtie ------------------------------------------------------
const scrise = [];
let randuri = [];

function fakeDb() {
  return {
    prepare(sql) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      return {
        async all() {
          if (/FROM planuri_lunare/i.test(s)) return randuri;
          return [];
        },
        async get(...a) {
          if (/FROM planuri_lunare/i.test(s)) return randuri.find((r) => Number(r.id) === Number(a[0])) || null;
          return null;
        },
        async run(...a) {
          scrise.push({ sql: s, args: a });
          if (/^INSERT INTO planuri_lunare/i.test(s)) {
            randuri.push({
              id: randuri.length + 1,
              luna: a[0], nume_fisier: a[1], mime: a[2], marime: a[3],
              drive_id: a[4], link: a[5], continut_base64: a[6], nota: a[7],
              observatii: a[8], incarcat_de: a[9], activ: 1,
              incarcat_la: "2026-10-27 16:00:00", incarcat_de_nume: "Valentin Oeru",
            });
          }
          if (/^UPDATE planuri_lunare SET activ = 0/i.test(s)) {
            const r = randuri.find((x) => Number(x.id) === Number(a[0]));
            if (r) r.activ = 0;
          }
          return { lastInsertRowid: randuri.length };
        },
      };
    },
    async exec() {},
  };
}

function pune(cale, exporturi) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = exporturi;
  require.cache[abs] = m;
}

pune("./lib/db", fakeDb());
// Drive nu există în testul ăsta. Îl facem să cadă, fiindcă ăla e cazul
// interesant: căderea Drive-ului NU trebuie să piardă urcarea.
let driveCade = true;
const urcariDrive = [];
pune("./lib/drive", {
  async cale(bucati, radacina) {
    if (driveCade) throw new Error("Drive de probă: indisponibil");
    return `folder-${bucati.join("/")}-sub-${radacina}`;
  },
  async urca(x) {
    if (driveCade) throw new Error("Drive de probă: indisponibil");
    urcariDrive.push(x);
    return { id: "drv1", link: "https://drive.google.com/file/d/drv1/view", marime: x.continut.length };
  },
});

const PLAN = require("./lib/plan-lunar");
const utilaje = require("./modules/utilaje");

// ---- un router de hârtie -------------------------------------------------
const rute = { get: new Map(), post: new Map() };
utilaje.register({
  get: (cale, f) => rute.get.set(cale, f),
  post: (cale, f) => rute.post.set(cale, f),
});

function raspuns() {
  const r = { cod: 0, antete: {}, corp: null, headersSent: false };
  r.writeHead = (cod, antete) => {
    r.cod = cod;
    Object.assign(r.antete, antete || {});
    r.headersSent = true;
  };
  r.end = (c) => {
    r.corp = c;
  };
  return r;
}

async function cheama(metoda, cale, { body, query, params, user } = {}) {
  const f = rute[metoda].get(cale);
  assert.ok(f, `ruta ${metoda.toUpperCase()} ${cale} nu e înregistrată`);
  const res = raspuns();
  await f({ res, body: body || {}, query: query || {}, params: params || {}, user: user || { id: 1, rol: "admin" }, req: { headers: {} } });
  return res;
}

const fisierDe = (filename, octeti) => ({
  filename,
  contentType: "application/octet-stream",
  data: Buffer.from("x".repeat(octeti === undefined ? 64 : octeti)),
});

// ---- verificările --------------------------------------------------------
(async () => {
  await test("rutele există, cu numele pe care le cheamă formularul", () => {
    assert.ok(rute.post.has("/productie/planificare/fisier"));
    assert.ok(rute.get.has("/productie/planificare/fisier/:id"));
    assert.ok(rute.post.has("/productie/planificare/fisier/:id/sterge"));
    assert.ok(rute.get.has("/productie/planificare"));
  });

  await test("un fișier bun se scrie, cu luna și cine l-a urcat", async () => {
    randuri = [];
    scrise.length = 0;
    const res = await cheama("post", "/productie/planificare/fisier", {
      body: { luna: "2026-11", observatii: "varianta de lucru", __files: { fisier: [fisierDe("Plan noiembrie.xlsx", 2048)] } },
      user: { id: 7, rol: "admin" },
    });
    assert.strictEqual(res.cod, 302);
    const ins = scrise.find((x) => /^INSERT INTO planuri_lunare/i.test(x.sql));
    assert.ok(ins, "nu s-a scris nimic în bază");
    assert.strictEqual(ins.args[0], "2026-11");
    assert.strictEqual(ins.args[1], "Plan noiembrie.xlsx");
    assert.strictEqual(ins.args[3], 2048, "mărimea scrisă trebuie să fie cea reală");
    assert.strictEqual(ins.args[8], "varianta de lucru");
    assert.strictEqual(ins.args[9], 7, "se scrie cine a urcat");
  });

  await test("Drive căzut NU pierde fișierul — rămâne în ERP și se spune", async () => {
    randuri = [];
    scrise.length = 0;
    driveCade = true;
    const res = await cheama("post", "/productie/planificare/fisier", {
      body: { luna: "2026-11", __files: { fisier: [fisierDe("plan.xlsx", 100)] } },
    });
    const ins = scrise.find((x) => /^INSERT INTO planuri_lunare/i.test(x.sql));
    assert.strictEqual(ins.args[4], null, "fără drive_id");
    assert.ok(ins.args[6], "conținutul trebuie salvat în bază");
    assert.strictEqual(Buffer.from(ins.args[6], "base64").length, 100, "octeții salvați trebuie să fie toți");
    assert.match(String(ins.args[7]), /Drive/, "nota trebuie să spună ce s-a întâmplat");
    assert.match(decodeURIComponent(res.antete.Location), /Drive/, "și omul trebuie să afle, nu doar baza");
  });

  await test("Drive care merge: se ține linkul, nu octeții", async () => {
    randuri = [];
    scrise.length = 0;
    urcariDrive.length = 0;
    driveCade = false;
    process.env.GOOGLE_DRIVE_FOLDER = "radacina-de-proba";
    await cheama("post", "/productie/planificare/fisier", {
      body: { luna: "2026-10", __files: { fisier: [fisierDe("plan.xlsx", 100)] } },
    });
    const ins = scrise.find((x) => /^INSERT INTO planuri_lunare/i.test(x.sql));
    assert.strictEqual(ins.args[4], "drv1");
    assert.match(String(ins.args[5]), /^https:\/\/drive\.google\.com\//);
    assert.strictEqual(ins.args[6], null, "nu ținem și octeții în bază degeaba");
    assert.strictEqual(ins.args[7], null, "fără notă, fiindcă n-a fost nicio problemă");
    assert.strictEqual(urcariDrive[0].mime, PLAN.TIPURI[0].mime, "mime-ul corect, nu octet-stream");
    assert.ok(urcariDrive[0].nume.startsWith("2026-10-"), urcariDrive[0].nume);
    driveCade = true;
    delete process.env.GOOGLE_DRIVE_FOLDER;
  });

  await test("un fișier greșit e refuzat și NU ajunge în bază", async () => {
    randuri = [];
    scrise.length = 0;
    const res = await cheama("post", "/productie/planificare/fisier", {
      body: { luna: "2026-11", __files: { fisier: [fisierDe("virus.exe", 10)] } },
    });
    assert.strictEqual(res.cod, 302);
    assert.match(decodeURIComponent(res.antete.Location), /plan_eroare/);
    assert.strictEqual(scrise.filter((x) => /^INSERT/i.test(x.sql)).length, 0, "nimic nu trebuie scris");
  });

  await test("formular fără fișier: mesaj, nu eroare de server", async () => {
    scrise.length = 0;
    const res = await cheama("post", "/productie/planificare/fisier", { body: { luna: "2026-11" } });
    assert.strictEqual(res.cod, 302);
    assert.match(decodeURIComponent(res.antete.Location), /plan_eroare/);
    assert.strictEqual(scrise.filter((x) => /^INSERT/i.test(x.sql)).length, 0);
  });

  await test("descărcarea unui fișier rămas în ERP dă octeții și numele lui", async () => {
    randuri = [
      { id: 5, luna: "2026-11", nume_fisier: "Plan noiembrie.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        marime: 3, link: null, continut_base64: Buffer.from("abc").toString("base64"), activ: 1 },
    ];
    const res = await cheama("get", "/productie/planificare/fisier/:id", { params: { id: "5" } });
    assert.strictEqual(res.cod, 200);
    assert.strictEqual(res.corp.toString(), "abc");
    assert.match(res.antete["Content-Disposition"], /filename="Plan noiembrie\.xlsx"/);
    assert.strictEqual(res.antete["Content-Length"], 3);
  });

  await test("un nume cu ghilimele nu rupe antetul de descărcare", async () => {
    randuri = [{ id: 6, luna: "2026-11", nume_fisier: 'plan "final".xlsx', continut_base64: Buffer.from("a").toString("base64"), activ: 1 }];
    const res = await cheama("get", "/productie/planificare/fisier/:id", { params: { id: "6" } });
    assert.ok(!/"\s*final/.test(res.antete["Content-Disposition"].replace('filename="', "")), res.antete["Content-Disposition"]);
  });

  await test("un fișier din Drive se deschide în Drive, nu se descarcă prin noi", async () => {
    randuri = [{ id: 9, luna: "2026-10", nume_fisier: "plan.xlsx", link: "https://drive.google.com/file/d/x/view", activ: 1 }];
    const res = await cheama("get", "/productie/planificare/fisier/:id", { params: { id: "9" } });
    assert.strictEqual(res.cod, 302);
    assert.strictEqual(res.antete.Location, "https://drive.google.com/file/d/x/view");
  });

  await test("un id inexistent nu crapă, doar trimite înapoi", async () => {
    randuri = [];
    const res = await cheama("get", "/productie/planificare/fisier/:id", { params: { id: "999" } });
    assert.strictEqual(res.cod, 302);
  });

  await test("doar adminul scoate o versiune", async () => {
    randuri = [{ id: 3, luna: "2026-10", nume_fisier: "plan.xlsx", activ: 1 }];
    await cheama("post", "/productie/planificare/fisier/:id/sterge", { params: { id: "3" }, user: { id: 2, rol: "productie" } });
    assert.strictEqual(randuri[0].activ, 1, "cine nu e admin nu trebuie să poată scoate");
    await cheama("post", "/productie/planificare/fisier/:id/sterge", { params: { id: "3" }, user: { id: 1, rol: "admin" } });
    assert.strictEqual(randuri[0].activ, 0);
  });

  await test("scoaterea e activ = 0, nu DELETE — versiunile sunt istoria", () => {
    const sters = scrise.find((x) => /planuri_lunare SET activ = 0/i.test(x.sql));
    assert.ok(sters, "trebuie să fie un UPDATE, nu un DELETE");
    assert.ok(!scrise.some((x) => /DELETE FROM planuri_lunare/i.test(x.sql)));
  });

  await test("pagina de planificare arată zona, și o arată goală fără să crape", async () => {
    randuri = [];
    const res = await cheama("get", "/productie/planificare", { query: {} });
    assert.strictEqual(res.cod, 200);
    const html = String(res.corp);
    assert.ok(html.includes('id="plan-lunar"'), "lipsește secțiunea");
    assert.ok(html.includes("Fișierul de planificare lunară"));
    assert.ok(html.includes('enctype="multipart/form-data"'), "fără enctype, fișierul nu ajunge niciodată la server");
    assert.ok(html.includes('name="fisier"') && html.includes('name="luna"'));
    assert.ok(html.includes("Nu e urcat încă"), "fără niciun plan, cardul trebuie să spună asta");
  });

  await test("cu versiuni, cea curentă e marcată și istoricul e sub ea", async () => {
    randuri = [
      { id: 1, luna: PLAN.lunaCurenta(), nume_fisier: "v1.xlsx", marime: 1024, incarcat_la: "2026-10-01 09:00:00", incarcat_de_nume: "Ana", activ: 1 },
      { id: 2, luna: PLAN.lunaCurenta(), nume_fisier: "v2.xlsx", marime: 2048, incarcat_la: "2026-10-20 09:00:00", incarcat_de_nume: "Ana", activ: 1 },
    ];
    const html = String((await cheama("get", "/productie/planificare", { query: {} })).corp);
    assert.ok(html.includes("v2.xlsx"), "versiunea curentă trebuie să fie în card");
    assert.ok(html.includes("v1.xlsx"), "cea veche trebuie să rămână vizibilă");
    assert.ok(html.includes("1 versiune anterioară"), "cardul trebuie să spună câte au fost înainte");
    assert.ok(html.indexOf("v2.xlsx") < html.indexOf("v1.xlsx"), "cea nouă deasupra");
  });

  await test("luna curentă e deschisă, lunile trecute stau strânse", async () => {
    randuri = [
      { id: 2, luna: PLAN.lunaCurenta(), nume_fisier: "acum.xlsx", marime: 1, incarcat_la: "2026-10-20 09:00:00", activ: 1 },
      { id: 1, luna: "2026-09", nume_fisier: "septembrie.pdf", marime: 1, incarcat_la: "2026-09-02 09:00:00", activ: 1 },
      { id: 0, luna: "2026-08", nume_fisier: "august.pdf", marime: 1, incarcat_la: "2026-08-02 09:00:00", activ: 1 },
    ];
    const html = String((await cheama("get", "/productie/planificare", { query: {} })).corp);
    assert.ok(html.includes("<details"), "lunile vechi trebuie strânse, altfel pagina crește la nesfârșit");
    assert.ok(html.includes("Lunile trecute (2)"));
    // Luna curentă NU e în details: trebuie să se vadă fără niciun clic.
    assert.ok(html.indexOf("acum.xlsx") < html.indexOf("<details"), "luna curentă stă deasupra, deschisă");
  });

  await test("tabelele au derulare pe orizontală, pentru telefon", async () => {
    randuri = [{ id: 1, luna: PLAN.lunaCurenta(), nume_fisier: "a.xlsx", marime: 1, incarcat_la: "2026-10-20 09:00:00", activ: 1 }];
    const html = String((await cheama("get", "/productie/planificare", { query: {} })).corp);
    const i = html.indexOf('id="plan-lunar"');
    const j = html.indexOf("<h2>Utilaje");
    assert.ok(html.slice(i, j).includes("overflow-x:auto"), "fără asta, „Observații” iese din ecran pe telefon");
  });

  await test("formularul acceptă exact ce acceptă serverul", async () => {
    const html = String((await cheama("get", "/productie/planificare", { query: {} })).corp);
    for (const t of PLAN.TIPURI) assert.ok(html.includes("." + t.ext), `.${t.ext} lipsește din accept`);
    assert.ok(!html.includes(".exe"));
  });

  console.log(`\n${treceri} verificări trecute.`);
})().catch((e) => {
  console.error("\nCĂZUT:", e.message);
  process.exit(1);
});
