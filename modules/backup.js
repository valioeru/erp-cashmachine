"use strict";
// Backup — o copie a întregii baze de date, într-un singur fișier.
//
// De ce nu urcă aplicația singură în Drive: ca să scrie în Drive-ul lui Vali,
// aplicația ar avea nevoie de un token Google ținut pe Render. Un secret în
// plus, care circulă și care poate fi furat, pentru o treabă care se face
// oricum o dată pe noapte. Așa că aplicația face doar partea care e treaba
// ei — pune toată baza într-un fișier, la cerere — iar copierea în Drive o
// face sesiunea programată din Cowork, cu contul lui Google, deja logat.
//
// Fișierul e JSON gzip-uit: se citește cu orice, se restaurează cu un script
// scurt, și nu depinde de versiunea de Postgres.
const zlib = require("zlib");
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Ordinea contează la restaurare: întâi tabelele de care depind celelalte.
const TABELE_CUNOSCUTE = [
  "firme", "utilizatori", "parteneri", "produse", "depozite", "miscari_stoc",
  "comenzi", "comenzi_linii", "facturi", "facturi_linii", "plati", "angajati", "salarii",
  "interactiuni", "retete_componente", "oportunitati", "leaduri", "taskuri", "taskuri_comentarii",
  "comenzi_productie", "tranzactii_banca", "balante_snapshot", "cashflow_manual",
  "oferte", "oferte_linii", "contracte", "profit_produs", "alias_parteneri", "alocari_clienti",
  "costuri_personal", "plan_conturi", "inregistrari_contabile", "contabilitate_rulari",
  "agenda_externa", "stiri", "setari_app", "notificari_facturi", "emailuri",
  "rezervari_stoc", "aprovizionari", "cereri_materie_prima", "calculator_categorii",
];

// Sesiunile și zona de tranzit a punții nu intră în backup: prima e efemeră,
// a doua e o cutie poștală, nu date.
const SARITE = new Set(["sesiuni", "punte_staging", "punti_import"]);

async function listaTabele() {
  try {
    const r = await db
      .prepare(
        `SELECT table_name AS nume FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      )
      .all();
    const gasite = r.map((x) => x.nume).filter((n) => !SARITE.has(n));
    if (gasite.length) {
      // ordinea cunoscută întâi, restul (tabele noi) după
      const cunoscute = TABELE_CUNOSCUTE.filter((t) => gasite.includes(t));
      const restul = gasite.filter((t) => !cunoscute.includes(t));
      return cunoscute.concat(restul);
    }
  } catch (e) {
    /* harness local, fără information_schema */
  }
  return TABELE_CUNOSCUTE.filter((t) => !SARITE.has(t));
}

async function construieste() {
  const tabele = await listaTabele();
  const date = {};
  let randuri = 0;
  const sarite = [];
  for (const t of tabele) {
    try {
      const r = await db.prepare(`SELECT * FROM ${t}`).all();
      date[t] = r;
      randuri += r.length;
    } catch (e) {
      sarite.push(`${t}: ${e.message}`);
    }
  }
  const obiect = {
    aplicatie: "ERP Cash Machine",
    creat_la: new Date().toISOString(),
    tabele: Object.keys(date).length,
    randuri,
    sarite,
    date,
  };
  const json = JSON.stringify(obiect);
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  return { gz, randuri, tabele: Object.keys(date).length, octeti: gz.length, json_octeti: json.length, sarite };
}

function marime(n) {
  const o = Number(n) || 0;
  if (o > 1024 * 1024) return (o / 1024 / 1024).toFixed(1) + " MB";
  if (o > 1024) return (o / 1024).toFixed(0) + " KB";
  return o + " B";
}

function numeFisier() {
  return `erp-cashmachine-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
}

function register(router) {
  router.get("/admin/backup", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const tabele = await listaTabele();
    const numarate = [];
    for (const t of tabele) {
      try {
        const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
        numarate.push({ tabel: t, n: Number(r.n || 0) });
      } catch (e) {
        numarate.push({ tabel: t, n: null });
      }
    }
    const total = numarate.reduce((s, x) => s + (x.n || 0), 0);
    const ultim = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'backup_ultim'").get();

    const body = `
      <p style="max-width:760px;color:var(--text-muted)">
        Un singur fișier cu toată baza de date, JSON gzip-uit. Îl poți descărca oricând de aici, iar sesiunea
        programată din Cowork îl ia noaptea și îl pune în folderul din Google Drive. Aplicația nu are token de
        Google și nici nu-i trebuie unul — nu ținem secrete pe Render pentru o treabă care se face cu contul tău,
        deja logat.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Tabele</div><div class="value">${numarate.length}</div></div>
        <div class="card"><div class="label">Rânduri în total</div><div class="value">${total.toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Ultimul backup dus în Drive</div>
          <div class="value" style="font-size:18px">${ultim && ultim.valoare ? esc(String(ultim.valoare).slice(0, 16)) : "—"}</div></div>
      </div>
      <div class="toolbar">
        <a class="btn" href="/admin/backup/descarca">Descarcă backup-ul acum</a>
      </div>
      ${table(
        ["Tabel", "Rânduri"],
        numarate.map((x) => [esc(x.tabel), x.n === null ? '<span class="badge gri">necitit</span>' : x.n.toLocaleString("ro-RO")])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Backup", active: "/admin/utilizatori", body }));
  });

  router.get("/admin/backup/descarca", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const b = await construieste();
    ctx.res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${numeFisier()}"`,
      "Content-Length": b.gz.length,
      "X-Backup-Randuri": String(b.randuri),
      "X-Backup-Tabele": String(b.tabele),
    });
    ctx.res.end(b.gz);
  });

  // Marcăm când a ajuns copia în Drive — apăsat de sesiunea programată după
  // ce urcarea a reușit, ca pagina să spună adevărul, nu intenția.
  router.post("/admin/backup/confirma-drive", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const t = new Date().toISOString().slice(0, 19).replace("T", " ");
    const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = 'backup_ultim'").get();
    if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = 'backup_ultim'").run(t, t);
    else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('backup_ultim', ?, ?)").run(t, t);
    redirect(ctx.res, "/admin/backup");
  });
}

module.exports = { register, construieste, numeFisier, marime };
