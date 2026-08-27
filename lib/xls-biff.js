"use strict";
// Citire nativă a fișierelor .xls (BIFF8) exportate de SmartBill.
//
// De ce există fișierul ăsta: TOATE exporturile din SmartBill Cloud vin ca
// .xls binar vechi (OLE2/BIFF8), nu ca .xlsx. Pachetul npm "xlsx" nu e
// instalabil pe serverul ăsta, iar a cere utilizatorului să deschidă fiecare
// export în Excel și să-l salveze ca CSV înseamnă un pas manual la fiecare
// import — adică, în practică, importuri care nu se mai fac.
//
// Implementarea acoperă exact subsetul de care au nevoie exporturile
// SmartBill: containerul OLE (CFB), stream-ul "Workbook", și înregistrările
// BIFF cu valori: SST/LABELSST (texte), LABEL, NUMBER, RK, MULRK, FORMULA +
// STRING, BLANK/MULBLANK. Nu e un parser Excel complet și nu încearcă să
// fie — formule, stiluri, grafice sunt ignorate deliberat.

// ---------- containerul OLE (Compound File Binary) ------------------------
function citesteCFB(buf) {
  const semnatura = buf.readUInt32LE(0);
  if (semnatura !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("Fișierul nu pare un .xls (lipsește semnătura OLE).");
  }
  const sectorShift = buf.readUInt16LE(30);
  const miniSectorShift = buf.readUInt16LE(32);
  const dimSector = 1 << sectorShift;
  const dimMiniSector = 1 << miniSectorShift;
  const nrFatSectoare = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const pragMiniStream = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  const difatStart = buf.readUInt32LE(68);
  const nrDifatSectoare = buf.readUInt32LE(72);

  const offsetSector = (s) => (s + 1) * dimSector;

  // DIFAT: primele 109 intrări sunt în header, restul în lanț de sectoare.
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v === 0xffffffff) break;
    difat.push(v);
  }
  let s = difatStart;
  for (let k = 0; k < nrDifatSectoare && s !== 0xffffffff && s !== 0xfffffffe; k++) {
    const baza = offsetSector(s);
    const perSector = dimSector / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const v = buf.readUInt32LE(baza + i * 4);
      if (v !== 0xffffffff) difat.push(v);
    }
    s = buf.readUInt32LE(baza + dimSector - 4);
  }

  // FAT
  const fat = [];
  for (const sec of difat.slice(0, Math.max(nrFatSectoare, difat.length))) {
    const baza = offsetSector(sec);
    if (baza + dimSector > buf.length) continue;
    for (let i = 0; i < dimSector / 4; i++) fat.push(buf.readUInt32LE(baza + i * 4));
  }

  const lant = (start, fatTab) => {
    const out = [];
    let cur = start;
    let paza = 0;
    while (cur !== 0xfffffffe && cur !== 0xffffffff && cur < fatTab.length && paza++ < 1000000) {
      out.push(cur);
      cur = fatTab[cur];
    }
    return out;
  };

  const citesteLant = (start, dim) => {
    const sectoare = lant(start, fat);
    const parti = sectoare.map((sec) => buf.slice(offsetSector(sec), offsetSector(sec) + dimSector));
    const tot = Buffer.concat(parti);
    return dim && dim < tot.length ? tot.slice(0, dim) : tot;
  };

  // directorul
  const dirBuf = citesteLant(dirStart, 0);
  const intrari = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const lungNume = dirBuf.readUInt16LE(off + 64);
    if (lungNume <= 0 || lungNume > 64) continue;
    const nume = dirBuf.slice(off, off + lungNume - 2).toString("utf16le");
    const tip = dirBuf.readUInt8(off + 66);
    intrari.push({ nume, tip, start: dirBuf.readUInt32LE(off + 116), dim: Number(dirBuf.readBigUInt64LE(off + 120)) });
  }

  const radacina = intrari.find((e) => e.tip === 5);
  const miniFat = radacina ? lant(miniFatStart, fat) : [];
  const miniFatTab = [];
  for (const sec of miniFat) {
    const baza = offsetSector(sec);
    for (let i = 0; i < dimSector / 4; i++) miniFatTab.push(buf.readUInt32LE(baza + i * 4));
  }
  const miniStream = radacina && radacina.dim > 0 ? citesteLant(radacina.start, radacina.dim) : Buffer.alloc(0);

  const citesteStream = (intrare) => {
    if (intrare.dim < pragMiniStream && miniStream.length) {
      const sectoare = lant(intrare.start, miniFatTab);
      const parti = sectoare.map((sec) => miniStream.slice(sec * dimMiniSector, (sec + 1) * dimMiniSector));
      const tot = Buffer.concat(parti);
      return tot.slice(0, intrare.dim);
    }
    return citesteLant(intrare.start, intrare.dim);
  };

  return { intrari, citesteStream };
}

// ---------- valori numerice codate RK -------------------------------------
function decodRK(v) {
  let f;
  if (v & 0x02) {
    f = (v | 0) >> 2; // întreg pe 30 de biți, cu semn
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(v & 0xfffffffc, 4);
    f = b.readDoubleLE(0);
  }
  if (v & 0x01) f = f / 100;
  return f;
}

// ---------- tabela de texte partajate (SST), inclusiv CONTINUE ------------
// Un string poate fi tăiat la granița dintre SST și CONTINUE; la reluare
// urmează un octet de flag care spune dacă restul e comprimat (1 octet /
// caracter) sau nu (2 octeți). De-aia citirea merge pe segmente, nu pe un
// buffer concatenat naiv.
function citesteSST(segmente) {
  let seg = 0;
  let poz = 0;
  const maiSunt = () => seg < segmente.length && (poz < segmente[seg].length || seg < segmente.length - 1);
  const treciLaUrmator = () => {
    if (poz >= segmente[seg].length && seg < segmente.length - 1) {
      seg++;
      poz = 0;
      return true; // s-a schimbat segmentul
    }
    return false;
  };
  const u8 = () => {
    treciLaUrmator();
    return segmente[seg][poz++];
  };
  const u16 = () => {
    if (poz + 2 <= segmente[seg].length) {
      const v = segmente[seg].readUInt16LE(poz);
      poz += 2;
      return v;
    }
    const a = u8();
    const b = u8();
    return a | (b << 8);
  };
  const u32 = () => u16() | (u16() << 16);

  u32(); // total strings
  const unice = u32();
  const texte = [];
  for (let i = 0; i < unice && seg < segmente.length; i++) {
    if (poz >= segmente[seg].length && seg >= segmente.length - 1) break;
    const cch = u16();
    let grbit = u8();
    let latime = grbit & 0x01 ? 2 : 1;
    const bogat = !!(grbit & 0x08);
    const extins = !!(grbit & 0x04);
    let nrRuns = 0;
    let dimExt = 0;
    if (bogat) nrRuns = u16();
    if (extins) dimExt = u32();

    let text = "";
    let ramase = cch;
    while (ramase > 0) {
      if (poz >= segmente[seg].length) {
        if (seg >= segmente.length - 1) break;
        seg++;
        poz = 0;
        grbit = segmente[seg][poz++]; // flag nou după CONTINUE
        latime = grbit & 0x01 ? 2 : 1;
      }
      const disponibil = Math.floor((segmente[seg].length - poz) / latime);
      const n = Math.min(ramase, disponibil);
      if (n <= 0) {
        if (seg >= segmente.length - 1) break;
        seg++;
        poz = 0;
        grbit = segmente[seg][poz++];
        latime = grbit & 0x01 ? 2 : 1;
        continue;
      }
      const felie = segmente[seg].slice(poz, poz + n * latime);
      text += latime === 2 ? felie.toString("utf16le") : felie.toString("latin1");
      poz += n * latime;
      ramase -= n;
    }
    // sărim peste formatare bogată / date extinse
    let deSarit = nrRuns * 4 + dimExt;
    while (deSarit > 0 && seg < segmente.length) {
      const disp = segmente[seg].length - poz;
      if (disp <= 0) {
        if (seg >= segmente.length - 1) break;
        seg++;
        poz = 0;
        continue;
      }
      const n = Math.min(deSarit, disp);
      poz += n;
      deSarit -= n;
    }
    texte.push(text);
  }
  return texte;
}

// ---------- formate de dată ----------------------------------------------
// Ne interesează doar dacă o celulă numerică e de fapt o dată. Formatele
// implicite 14..22 și 45..47 sunt de dată/oră; pentru cele definite de
// utilizator ne uităm dacă șirul de format conține y/m/d.
function esteFormatData(cod, sirFormat) {
  if ((cod >= 14 && cod <= 22) || (cod >= 45 && cod <= 47)) return true;
  if (!sirFormat) return false;
  const f = sirFormat.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
  return /[yd]/i.test(f) && /[ymd]/i.test(f);
}

function serialLaData(n) {
  // Excel numără zilele de la 1899-12-30 (cu bug-ul anului 1900 inclus).
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ---------- parcurgerea înregistrărilor BIFF ------------------------------
function parseXLS(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { intrari, citesteStream } = citesteCFB(buf);
  const intrareWb = intrari.find((e) => /^(Workbook|Book)$/i.test(e.nume));
  if (!intrareWb) throw new Error("Nu găsesc stream-ul Workbook în fișierul .xls.");
  const wb = citesteStream(intrareWb);

  // 1) trecere de recunoaștere: SST, formate, XF
  const formate = new Map(); // cod format -> șir
  const xf = []; // index XF -> cod format
  let sst = [];
  let off = 0;
  const inregistrari = [];
  while (off + 4 <= wb.length) {
    const cod = wb.readUInt16LE(off);
    const dim = wb.readUInt16LE(off + 2);
    const date = wb.slice(off + 4, off + 4 + dim);
    inregistrari.push({ cod, date, off });
    off += 4 + dim;
  }

  for (let i = 0; i < inregistrari.length; i++) {
    const r = inregistrari[i];
    if (r.cod === 0x00fc) {
      const segmente = [r.date];
      for (let j = i + 1; j < inregistrari.length && inregistrari[j].cod === 0x003c; j++) segmente.push(inregistrari[j].date);
      try {
        sst = citesteSST(segmente);
      } catch (e) {
        sst = [];
      }
    } else if (r.cod === 0x041e && r.date.length >= 4) {
      // FORMAT
      const codFormat = r.date.readUInt16LE(0);
      const cch = r.date.readUInt16LE(2);
      const grbit = r.date[4];
      const latime = grbit & 0x01 ? 2 : 1;
      const felie = r.date.slice(5, 5 + cch * latime);
      formate.set(codFormat, latime === 2 ? felie.toString("utf16le") : felie.toString("latin1"));
    } else if (r.cod === 0x00e0 && r.date.length >= 4) {
      // XF
      xf.push(r.date.readUInt16LE(2));
    }
  }

  const eData = (indexXf) => {
    const codFormat = xf[indexXf];
    if (codFormat === undefined) return false;
    return esteFormatData(codFormat, formate.get(codFormat));
  };

  // 2) trecere de valori — luăm prima foaie (exporturile SmartBill au una)
  const celule = new Map(); // "rand:col" -> valoare
  let maxRand = -1;
  let maxCol = -1;
  const pune = (rand, col, val) => {
    if (val === "" || val === null || val === undefined) return;
    celule.set(`${rand}:${col}`, val);
    if (rand > maxRand) maxRand = rand;
    if (col > maxCol) maxCol = col;
  };

  let indexBof = 0;
  for (let i = 0; i < inregistrari.length; i++) {
    const r = inregistrari[i];
    const d = r.date;
    switch (r.cod) {
      case 0x0809: // BOF
        indexBof++;
        break;
      case 0x00fd: {
        // LABELSST
        if (d.length < 10) break;
        const idx = d.readUInt32LE(6);
        pune(d.readUInt16LE(0), d.readUInt16LE(2), sst[idx] !== undefined ? sst[idx] : "");
        break;
      }
      case 0x0204: {
        // LABEL (text direct)
        if (d.length < 8) break;
        const cch = d.readUInt16LE(6);
        const grbit = d[8];
        const latime = grbit & 0x01 ? 2 : 1;
        const felie = d.slice(9, 9 + cch * latime);
        pune(d.readUInt16LE(0), d.readUInt16LE(2), latime === 2 ? felie.toString("utf16le") : felie.toString("latin1"));
        break;
      }
      case 0x0203: {
        // NUMBER
        if (d.length < 14) break;
        const rand = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        const ixfe = d.readUInt16LE(4);
        const v = d.readDoubleLE(6);
        pune(rand, col, eData(ixfe) ? serialLaData(v) || v : v);
        break;
      }
      case 0x027e: {
        // RK
        if (d.length < 10) break;
        const rand = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        const ixfe = d.readUInt16LE(4);
        const v = decodRK(d.readUInt32LE(6));
        pune(rand, col, eData(ixfe) ? serialLaData(v) || v : v);
        break;
      }
      case 0x00bd: {
        // MULRK
        if (d.length < 6) break;
        const rand = d.readUInt16LE(0);
        let col = d.readUInt16LE(2);
        for (let p = 4; p + 6 <= d.length - 2; p += 6) {
          const ixfe = d.readUInt16LE(p);
          const v = decodRK(d.readUInt32LE(p + 2));
          pune(rand, col++, eData(ixfe) ? serialLaData(v) || v : v);
        }
        break;
      }
      case 0x0006: {
        // FORMULA — dacă rezultatul e text, urmează o înregistrare STRING
        if (d.length < 14) break;
        const rand = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        const ixfe = d.readUInt16LE(4);
        const eSir = d.readUInt16LE(12) === 0xffff && d[6] === 0x00;
        if (eSir) {
          const urm = inregistrari[i + 1];
          if (urm && urm.cod === 0x0207 && urm.date.length >= 3) {
            const cch = urm.date.readUInt16LE(0);
            const grbit = urm.date[2];
            const latime = grbit & 0x01 ? 2 : 1;
            const felie = urm.date.slice(3, 3 + cch * latime);
            pune(rand, col, latime === 2 ? felie.toString("utf16le") : felie.toString("latin1"));
          }
        } else {
          const v = d.readDoubleLE(6);
          if (!Number.isNaN(v)) pune(rand, col, eData(ixfe) ? serialLaData(v) || v : v);
        }
        break;
      }
      default:
        break;
    }
    if (indexBof > 2 && r.cod === 0x000a) break; // EOF după prima foaie de date
  }

  const randuri = [];
  for (let r = 0; r <= maxRand; r++) {
    const rand = [];
    for (let c = 0; c <= maxCol; c++) {
      const v = celule.get(`${r}:${c}`);
      rand.push(v === undefined ? "" : v);
    }
    randuri.push(rand);
  }
  return randuri;
}

module.exports = { parseXLS };
