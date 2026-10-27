"use strict";
// Istoricul modificărilor pe comandă. Fără bază de date.
//
// CE APĂRĂ:
//
//   • O SCHIMBARE NU SE PIERDE. Dacă ecranul pierde un câmp, se vede. Dacă
//     istoricul pierde o schimbare, nu se vede NICIODATĂ — iar peste trei luni,
//     când clientul spune „eu am comandat 20.000, nu 25.000", nu mai are cine
//     să răspundă.
//
//   • DAR NICI NU INVENTEAZĂ UNA. „25000" venit din formular și 25000 citit din
//     bază sunt același lucru. Dacă fiecare salvare ar scrie zece schimbări care
//     nu s-au întâmplat, istoricul n-ar mai fi citit de nimeni — și atunci nu
//     mai apără nimic. Zgomotul omoară un audit la fel de sigur ca o gaură.
//
//   • LINIILE SE COMPARĂ PE PRODUS, NU PE POZIȚIE. Omul șterge a doua linie și
//     adaugă alta la coadă. O comparație pe poziții ar scrie trei schimbări
//     acolo unde s-a întâmplat una, și niciuna adevărată.
//
//   • OWNERUL CLIENTULUI POATE, STRĂINUL NU. Asta e chiar cererea: agentul pe
//     al cărui nume stă firma să poată corecta orice comandă a clientului lui.
//
//   • O COMANDĂ FACTURATĂ ÎȘI SPUNE RISCUL. Nu se blochează — dar cine schimbă
//     trebuie să vadă înainte, nu să afle la inventar.
const I = require("./lib/comanda-istoric");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 240) : ""));
    esecuri++;
  }
}
const are = (lista, bucata) => lista.some((x) => x.ce.indexOf(bucata) !== -1);

console.log("Capul comenzii");
{
  const v = { partener_id: 7, numar: "CMD-12", observatii: "urgent", moneda: "RON", data_livrare_ceruta: "2026-11-02" };
  const n = { partener_id: 7, numar: "CMD-12b", observatii: "urgent", moneda: "EUR", data_livrare_ceruta: "2026-11-02" };
  const d = I.diferente(v, n, I.ETICHETE);
  bine("prinde exact cele două schimbări", d.length === 2, d);
  bine("le numește pe înțelesul omului", are(d, "Număr comandă") && are(d, "Moneda"), d.map((x) => x.ce));
  bine("păstrează și cum era, și cum a rămas",
    d.find((x) => x.ce === "Moneda").vechi === "RON" && d.find((x) => x.ce === "Moneda").nou === "EUR", d);
  bine("nu scrie nimic când nu s-a schimbat nimic", I.diferente(v, { ...v }, I.ETICHETE).length === 0);
}
{
  // Ăsta e zgomotul care omoară un audit: formularul trimite text, baza dă numere.
  const d = I.diferente({ partener_id: 7, numar: 12 }, { partener_id: "7", numar: "12" }, I.ETICHETE);
  bine("textul din formular și numărul din bază nu sunt «o schimbare»", d.length === 0, d);
  bine("nici spațiile de la capete", I.diferente({ observatii: "urgent" }, { observatii: "  urgent " }, I.ETICHETE).length === 0);
  bine("dar gol → ceva se vede", I.diferente({ observatii: "" }, { observatii: "sună-l întâi" }, I.ETICHETE).length === 1);
  bine("și ceva → gol se vede", I.diferente({ observatii: "sună-l" }, { observatii: "" }, I.ETICHETE).length === 1);
  bine("null și gol nu sunt o schimbare", I.diferente({ numar: null }, { numar: "" }, I.ETICHETE).length === 0);
}
{
  // O coloana tehnica adaugata maine in tabel n-are ce cauta in istoricul
  // citit de agent.
  const d = I.diferente({ verificata_depozit_la: "a" }, { verificata_depozit_la: "b", numar: "X" }, I.ETICHETE);
  bine("un câmp fără etichetă nu ajunge în istoric", d.length === 1 && d[0].ce === "Număr comandă", d);
}

console.log("\nLiniile");
const L = (id, den, c, p, um) => ({ produs_id: id, denumire: den, cantitate: c, pret_unitar: p, um: um || "buc" });
{
  const v = [L(1, "Pungă curier 350×450", 20000, 0.42), L(2, "Bandă adezivă 48×900", 100, 7.1)];
  const n = [L(1, "Pungă curier 350×450", 25000, 0.42), L(2, "Bandă adezivă 48×900", 100, 7.1)];
  const d = I.diferenteLinii(v, n);
  bine("o cantitate schimbată se vede", d.length === 1 && d[0].ce.indexOf("Cantitate") === 0, d);
  bine("scrie și cât era, și cât a rămas", d[0].vechi === "20000" && d[0].nou === "25000", d[0]);
  bine("spune pe care produs", d[0].ce.indexOf("Pungă curier") !== -1, d[0].ce);
}
{
  const v = [L(1, "Pungă curier", 1000, 0.42)];
  const n = [L(1, "Pungă curier", 1000, 0.5)];
  const d = I.diferenteLinii(v, n);
  bine("un preț schimbat se vede", d.length === 1 && d[0].ce.indexOf("Preț") === 0, d);
  bine("scris în bani, nu cu paisprezece zecimale", d[0].nou === "0,50", d[0].nou);
}
{
  // Cazul real: sterge o linie din mijloc si adauga alta la coada.
  const v = [L(1, "A", 10, 1), L(2, "B", 20, 2), L(3, "C", 30, 3)];
  const n = [L(1, "A", 10, 1), L(3, "C", 30, 3), L(4, "D", 40, 4)];
  const d = I.diferenteLinii(v, n);
  bine("exact două schimbări, nu patru", d.length === 2, d);
  bine("una adăugată", are(d, "Linie adăugată · D"), d.map((x) => x.ce));
  bine("una ștearsă", are(d, "Linie ștearsă · B"), d.map((x) => x.ce));
  bine("A și C n-au fost atinse", !are(d, "· A") && !are(d, "· C"), d.map((x) => x.ce));
}
{
  const d = I.diferenteLinii([], [L(1, "A", 5, 1)]);
  bine("prima linie pe o comandă goală e «adăugată»", d.length === 1 && d[0].ce.indexOf("adăugată") !== -1, d);
  bine("și scrie cantitatea cu unitate și preț", d[0].nou.indexOf("5 buc") === 0, d[0].nou);
  bine("golirea completă se vede", I.diferenteLinii([L(1, "A", 5, 1)], []).length === 1);
  bine("aceleași linii = nicio schimbare", I.diferenteLinii([L(1, "A", 5, 1)], [L(1, "A", 5, 1)]).length === 0);
}
{
  // Doua linii cu acelasi produs: greseala de introdus, dar nu avem voie sa
  // pierdem una din ele.
  const d = I.diferenteLinii([L(1, "A", 10, 1), L(1, "A", 5, 1)], [L(1, "A", 15, 1)]);
  bine("două linii cu același produs se adună, nu se pierd", d.length === 0, d);
}
{
  const d = I.diferenteLinii([L(1, "A", 10, 1, "buc")], [L(1, "A", 10, 1, "kg")]);
  bine("unitatea schimbată se vede", d.length === 1 && d[0].ce.indexOf("Unitate") === 0, d);
}

console.log("\nCine are voie");
{
  const comanda = { id: 5, agent_id: 11, partener_id: 3 };
  const client = { id: 3, agent_id: 22 };
  bine("adminul poate", I.poateEdita({ id: 99, rol: "admin" }, comanda, client));
  bine("agentul care a scris comanda poate", I.poateEdita({ id: 11, rol: "agent" }, comanda, client));
  // Asta e chiar cererea lui Vali.
  bine("ownerul clientului poate, chiar dacă n-a scris el comanda",
    I.poateEdita({ id: 22, rol: "agent" }, comanda, client));
  bine("un agent străin NU poate", !I.poateEdita({ id: 77, rol: "agent" }, comanda, client));
  bine("depozitul NU poate", !I.poateEdita({ id: 78, rol: "depozit" }, comanda, client));
  bine("nimeni nelogat nu poate", !I.poateEdita(null, comanda, client));
  bine("fără client cunoscut, agentul comenzii tot poate",
    I.poateEdita({ id: 11, rol: "agent" }, comanda, null));
}

console.log("\nCe i se spune înainte să salveze");
{
  bine("o comandă obișnuită n-are avertismente", I.avertismente({ status: "noua" }).length === 0);
  const f = I.avertismente({ status: "noua", factura_id: 8 });
  bine("comanda facturată avertizează", f.length === 1, f);
  bine("și spune că factura NU se rescrie singură", f[0].indexOf("nu se rescrie") !== -1, f[0]);
  bine("comanda anulată avertizează", I.avertismente({ status: "anulata" }).length === 1);
  bine("comanda livrată avertizează", I.avertismente({ status: "livrata" }).length === 1);
  bine("două probleme = două avertismente",
    I.avertismente({ status: "livrata", factura_id: 3 }).length === 2);
  bine("nu crapă pe nimic", I.avertismente(null).length === 0);
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
