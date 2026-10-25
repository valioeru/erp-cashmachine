#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Etichetele AWB Sameday (awbs.pdf) -> JSON pentru /rapoarte/comenzi-la-zi/awb.

    python3 -I awb-sameday.py <folder-cu-pdf-uri> -o etichete.json

Scoate pe stdout un raport de control si scrie fisierul JSON gata de urcat in
formularul „Incarca AWB-urile unei zile". Nimic nu se scrie in ERP de aici.

DE CE EXISTA FISIERUL ASTA. Parsarea a fost scrisa de la zero la fiecare rulare
de noapte, din regulile dintr-un prompt. De noua ori regulile s-au dovedit prea
inguste si de fiecare data marfa a disparut in tacere — niciodata cu eroare.
Ultima oara, pe 25.10.2026, cod de rutare cu „SEDIU" la mijloc. Un fisier care
se schimba o data si ramane schimbat nu are cum sa regreseze inapoi la o
versiune mai veche a regulilor.

ISTORICUL CAPCANELOR e in claude/awb-capcane-parsare-addendum*.md. Pe scurt,
fiecare regula de mai jos a costat bani reali inainte sa fie scrisa.
"""
import argparse
import collections
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata

# Preturile de vanzare catre Sameday, lei/bucata, valabile din 03.06.2026.
# Daca se schimba, se schimba AICI si in nomenclatorul din ERP; ERP-ul isi
# ingheata oricum pretul pe linia zilei, deci trecutul nu se rescrie.
PRET = {
    "Bandă adezivă, acrilic, Fragil": 4.14,
    "Bandă adezivă, acrilic, transparentă": 2.34,
    "Bandă adezivă, solvent, transparentă": 3.02,
    "Cutie mare, dimensiuni 460x410x373": 4.33,
    "Cutie medie SD2 (460 x 410 x 190)": 3.30,
    "Cutie mica SD3 (460 x 410 x 90)": 2.80,
    "Folie Stretch Hibrid/Prestretch - HV 15": 34.70,
    "Folie Stretch Standard 23 microni": 26.40,
    "Plic antișoc mare, H18, interior 270x360 mm": 0.63,
    "Plic antișoc mediu, G17, interior 230x340 mm": 0.50,
    "Plic antișoc mic, D14, interior 180x265 mm": 0.35,
    "Plic autoadeziv AWB C5": 0.09,
    "Plic format A3 (500x500mm)": 0.42,
    "Plic format A4 (300x400mm)": 0.22,
    "Top hârtie A4": 15.04,
}
# Scrierile de pe eticheta care difera de nomenclator.
ALIAS = {
    "Cutie mare SD1 (460 x 410 x 373)": "Cutie mare, dimensiuni 460x410x373",
    "Banda adeziva FRAGIL": "Bandă adezivă, acrilic, Fragil",
}


def cheie(s):
    """Fara diacritice, fara punctuatie, litere mici — pentru potrivirea numelor."""
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFD", str(s)).lower())


INDEX = {cheie(k): k for k in PRET}
INDEX.update({cheie(a): k for a, k in ALIAS.items()})

# CAPCANELE 4, 6, 8 si 9 — coada de rutare lipita la finalul numelui de produs.
# Formele vazute pana acum: „[37] B-ND-121", „[T60] IS-ND-227", „(T69)TM-ND-493",
# „MM_ND_104", „B-SD-183", „TM-LN-123", „SM-SEDIU-106".
# Nu se presupune NIMIC despre continutul codului, doar despre pozitia lui:
# LITERE separator LITERE separator CIFRE, fara spatii. Verificat ca niciunul
# din cele 15 nume de produse si niciun alias nu are tiparul asta.
RUTARE_IN_TEXT = re.compile(r"\[[^\]]*\]|\((?:T\s*\d+|\d+)\)|\b[A-Z]{1,4}[-_][A-Z]{2,6}[-_]\d+\b")
RUTARE_LINIE = re.compile(r"^(?:\(\s*\w+\s*\)\s*|\[\s*\w+\s*\]\s*)*[A-Z]{1,4}[-_][A-Z]{2,6}[-_]\d+$")
# CAPCANA 7 — codul de agentie nu se termina mereu cu _A##: exista IF_BRANESTI_S02.
AGENTIE = re.compile(r"^[A-Z]{1,3}_[A-Z0-9_]+_[A-Z]\d+$")
AWB_NR = re.compile(r"\b(1SDY\d{10,})\b")
DATA_AWB = re.compile(r"Data AWB:\s*(\d{2})\.(\d{2})\.(\d{4})")
LOC_JUD = re.compile(r"\(([^()]+)\)\s*,\s*([A-Za-zĂÂÎȘȚăâîșț .\-]+)")
SECTOR = re.compile(r"\bsector(?:ul)?\s*\d+", re.I)
GREUTATE = re.compile(r"Greutate:\s*([\d.,]+)\s*KG", re.I)
# Cantitatea e NUMARUL DIN FATA numelui, niciodata un numar din interiorul lui.
# „6Folie Stretch Standard 23 microni" inseamna 6 role de folie de 23 de
# microni, nu 23 de bucati. Vali, 25.10.2026: „ai grija, 23 sunt microni, nu
# bucati." Tiparul ancorat la inceput (^) e singurul lucru care tine regula asta.
CANTITATE = re.compile(r"^(\d+(?:[.,]\d+)?)\s*(.+)$")


def curata_produs(s):
    s = RUTARE_IN_TEXT.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip().strip(" -_,")


def nume_destinatar(linie):
    """CAPCANA 8 — „FIRMA SRL -... / ***3105": se taie la „ / ", apoi coada."""
    n = linie.split(" / ")[0]
    return re.sub(r"\s+-(\s|\.).*$", "", n).strip()


def blocuri(text):
    """O eticheta = un bloc care incepe cu antetul expeditorului."""
    return [p for p in re.split(r"(?=DELIVERY SOLUTIONS S\.A\.)", text) if "1SDY" in p]


def un_bloc(bl):
    linii = [l.strip() for l in bl.split("\n")]

    m = DATA_AWB.search(bl)
    data = "%s-%s-%s" % (m.group(3), m.group(2), m.group(1)) if m else None
    nrs = AWB_NR.findall(bl)
    awb = nrs[-1] if nrs else None
    g = GREUTATE.search(bl)

    e = {
        "awb": awb, "data": data,
        "kg": float(g.group(1).replace(",", ".")) if g else None,
        "destinatar": None, "adresa": None, "oras": None, "judet": None,
        "agentie": None, "obs": "",
    }

    # „DESTINATAR" e o eticheta pe verticala in marginea stanga: numele e pe
    # linia DINAINTE, adresa pe liniile de dupa.
    i = next((k for k, l in enumerate(linii) if l == "DESTINATAR"), None)
    if i is not None:
        for k in range(i - 1, max(i - 4, -1), -1):
            if linii[k]:
                e["destinatar"] = nume_destinatar(linii[k])
                break
        # CAPCANA 7 — blocul de adresa se opreste la linia de agentie. Daca merge
        # mai departe, inghite continuarea OBS-ului si tiparul nu se mai ancoreaza.
        bucati = []
        for l in linii[i + 1:]:
            if not l:
                continue
            if AGENTIE.match(l):
                e["agentie"] = l
                break
            if l.startswith("OBS:") or AWB_NR.search(l) or RUTARE_LINIE.match(l):
                break
            bucati.append(l)
        e["adresa"] = " ".join(bucati).strip() or None
        if e["adresa"]:
            # CAPCANA 5 — orasul e in paranteza, si se ia ULTIMA potrivire:
            # „str Patriei nr 56 bl 1AB ap. 2(langa Optimed) Buzau (Buzau), Buzau".
            pot = LOC_JUD.findall(e["adresa"])
            if pot:
                e["oras"], e["judet"] = pot[-1][0].strip(), pot[-1][1].strip()
                if cheie(e["judet"]).startswith("bucuresti"):
                    e["oras"] = "București"
            elif SECTOR.search(e["adresa"]):
                e["oras"], e["judet"] = "București", "București"

    # CAPCANA 4 — OBS-ul se rupe peste randuri, chiar peste randuri goale.
    i = next((k for k, l in enumerate(linii) if l.startswith("OBS:")), None)
    if i is not None:
        obs = linii[i][4:].strip()
        for l in linii[i + 1:]:
            if not l:
                continue
            if AWB_NR.search(l) or RUTARE_LINIE.match(l) or AGENTIE.match(l):
                break
            if l == "DESTINATAR" or l.startswith("OBS:"):
                break
            obs += " " + l
        e["obs"] = obs.strip()
    return e


def articole(obs):
    out, necunoscute = [], []
    for buc in obs.split("//"):
        buc = buc.strip()
        if not buc:
            continue
        m = CANTITATE.match(buc)
        if not m:
            necunoscute.append(buc)
            continue
        nume = curata_produs(m.group(2))
        k = INDEX.get(cheie(nume))
        if not k:
            necunoscute.append(nume)
            continue
        out.append({"cantitate": float(m.group(1).replace(",", ".")), "produs": k})
    return out, necunoscute


def zi_raport(data_awb):
    """CAPCANA 1 — ziua de raport e data de pe eticheta MINUS O ZI."""
    return (datetime.date.fromisoformat(data_awb) - datetime.timedelta(days=1)).isoformat()


def text_din_pdf(cale):
    """pdftotext -layout. Layout-ul conteaza: fara el, eticheta verticala
    DESTINATAR si coloanele se amesteca, iar adresa nu mai e gasibila."""
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as t:
        iesire = t.name
    try:
        subprocess.run(["pdftotext", "-layout", cale, iesire], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with open(iesire, encoding="utf-8", errors="replace") as f:
            return f.read()
    finally:
        try:
            os.unlink(iesire)
        except OSError:
            pass


def citeste(cai):
    """Fiecare cale e un .pdf sau un folder cu .pdf-uri."""
    fisiere = []
    for c in cai:
        if os.path.isdir(c):
            fisiere += sorted(glob.glob(os.path.join(c, "**", "*.pdf"), recursive=True))
        else:
            fisiere.append(c)
    etichete = []
    for f in fisiere:
        for bl in blocuri(text_din_pdf(f)):
            e = un_bloc(bl)
            e["fisier"] = os.path.basename(f)
            etichete.append(e)
    return fisiere, etichete


def main():
    ap = argparse.ArgumentParser(description="awbs.pdf Sameday -> JSON pentru ERP")
    ap.add_argument("cai", nargs="+", help="fisiere .pdf sau foldere cu .pdf")
    ap.add_argument("-o", "--iesire", default="etichete.json")
    args = ap.parse_args()

    fisiere, etichete = citeste(args.cai)

    # CAPCANA 2 — ultimele trei cifre ale AWB-ului sunt numarul coletului, iar
    # eticheta fiecarui colet repeta comanda intreaga. Deduplicarea de aici e
    # doar pentru controale: in ERP se trimit TOATE etichetele, el deduplica la
    # fel, iar asa iese si numarul de colete corect.
    exp, fara = {}, []
    for e in etichete:
        if not e["awb"] or not e["data"]:
            fara.append(e)
            continue
        k = e["awb"][:-3]
        if k in exp:
            exp[k]["colete"] += 1
            for c in ("destinatar", "oras", "judet", "agentie", "adresa"):
                if not exp[k].get(c) and e.get(c):
                    exp[k][c] = e[c]
        else:
            e["colete"] = 1
            exp[k] = e

    necunoscute = collections.Counter()
    fara_loc = []
    pe_zi = collections.defaultdict(lambda: {"expeditii": 0, "colete": 0, "valoare": 0.0})
    pe_produs = collections.defaultdict(lambda: collections.defaultdict(float))
    for e in exp.values():
        art, nec = articole(e["obs"])
        for n in nec:
            necunoscute[n] += 1
        if not e.get("oras") and not e.get("agentie"):
            fara_loc.append(e["awb"])
        z = zi_raport(e["data"])
        pe_zi[z]["expeditii"] += 1
        pe_zi[z]["colete"] += e["colete"]
        pe_zi[z]["valoare"] += sum(a["cantitate"] * PRET[a["produs"]] for a in art)
        for a in art:
            pe_produs[z][a["produs"]] += a["cantitate"]

    # Fisierul pentru ERP: o intrare pe ETICHETA, nu pe expeditie.
    iesire = []
    for e in etichete:
        if not e["awb"] or not e["data"]:
            continue
        art, _ = articole(e["obs"])
        iesire.append({
            "awb": e["awb"], "data": e["data"], "kg": e["kg"],
            "destinatar": e["destinatar"], "adresa": e["adresa"],
            "oras": e["oras"], "judet": e["judet"], "agentie": e["agentie"],
            "articole": art,
        })
    with open(args.iesire, "w", encoding="utf-8") as f:
        json.dump(iesire, f, ensure_ascii=False)

    print("%d fisiere, %d etichete, %d expeditii" % (len(fisiere), len(etichete), len(exp)))
    print()
    print("%-12s %9s %7s %13s" % ("ziua", "expeditii", "colete", "valoare"))
    total = 0.0
    for z in sorted(pe_zi):
        d = pe_zi[z]
        total += d["valoare"]
        print("%-12s %9d %7d %13s" % (z, d["expeditii"], d["colete"], format(d["valoare"], ",.2f")))
    print("%-12s %9d %7s %13s" % ("TOTAL", len(exp), "", format(total, ",.2f")))
    print()
    print("CONTROALE (toate trebuie sa fie 0):")
    print("  etichete fara AWB sau fara data: %d" % len(fara))
    print("  expeditii fara oras SI fara agentie: %d" % len(fara_loc))
    print("  articole nerecunoscute: %d" % sum(necunoscute.values()))
    for n, c in necunoscute.most_common():
        print("      %dx %r" % (c, n))
    print()
    print("Scris %s (%d etichete)." % (args.iesire, len(iesire)))
    if necunoscute:
        print("NU URCA fisierul: un articol nerecunoscut inseamna marfa care dispare "
              "din raport fara eroare. Adauga aliasul in ERP sau largeste regula.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
