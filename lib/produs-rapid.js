"use strict";
// Produsul scris direct pe comandă.
//
// Agentul are clientul la telefon si cere ceva ce nu e in nomenclator. Pana
// acum nu avea ce face: lista nu-l continea, campul ascuns ramanea gol si
// comanda nu se salva. Acum il poate adauga de pe loc.
//
// DAR: un nomenclator in care oricine adauga orice se strica in trei luni.
// Peste produse-fuziune.js am lucrat deja o data exact din cauza asta. Deci
// produsul creat asa intra marcat PROVIZORIU: e bun de comandat, dar e trecut
// pe o lista pe care achizitiile o duc la capat - cod, pret de achizitie,
// unitate corecta. Marcajul cade cand il completeaza cineva.
//
// Aici stau doar functiile pure: normalizarea pentru cautarea de duplicate si
// validarea. Sunt separate de ruta ca sa poata fi testate fara baza.

// Cheia pe care se cauta duplicatele. Doua denumiri sunt "aceeasi" daca, dupa
// ce scoatem diacriticele, semnele si spatiile duble, raman identice. Asa
// "Banda adeziva 48mm" si "BANDA ADEZIVA  48 MM" nu ajung doua randuri.
//
// Nu scoatem cifrele si nu scoatem unitatile: "folie 15 micron" si
// "folie 23 micron" SUNT produse diferite, iar o normalizare mai agresiva
// le-ar lipi intre ele - greseala mai scumpa decat un duplicat.
// Litera lipita de cifra se desparte: "48mm" si "48 mm" sunt acelasi lucru, iar
// fara pasul asta exact perechea aia ar fi intrat de doua ori in nomenclator -
// cazul cel mai des intalnit la benzi si folii. Efectul colateral, "CO3" ->
// "co 3", nu strica nimic: se aplica la fel pe ambele parti ale comparatiei.
function cheieDenumire(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const LIMITE = { denumireMin: 3, denumireMax: 200, categorieMax: 80, umMax: 12 };

// Ce vine prin HTTP nu se crede pe cuvant. Intoarce fie { eroare }, fie
// valorile curatate, gata de scris in baza.
function validare(brut) {
  const b = brut || {};
  const denumire = String(b.denumire == null ? "" : b.denumire).trim().replace(/\s+/g, " ");
  const categorie = String(b.categorie == null ? "" : b.categorie).trim();
  const um = String(b.um == null ? "" : b.um).trim();

  if (denumire.length < LIMITE.denumireMin) {
    return { eroare: "Scrie denumirea produsului - cel putin " + LIMITE.denumireMin + " caractere." };
  }
  if (denumire.length > LIMITE.denumireMax) {
    return { eroare: "Denumirea e prea lunga (maximum " + LIMITE.denumireMax + " caractere)." };
  }
  // O denumire formata numai din cifre si semne nu e denumire, e un cod scris
  // in casuta gresita. Lasata sa treaca, ajunge in nomenclator ca "1699".
  if (!/[a-z]/.test(cheieDenumire(denumire))) {
    return { eroare: "Denumirea trebuie sa contina si litere, nu doar cifre." };
  }

  return {
    denumire,
    // Categoria si unitatea sunt optionale: agentul nu le stie intotdeauna, iar
    // o comanda blocata pentru ca nu stie categoria e mai rea decat un produs
    // fara categorie, pe care achizitiile il completeaza oricum.
    categorie: categorie.slice(0, LIMITE.categorieMax) || null,
    um: (um.slice(0, LIMITE.umMax) || "buc"),
    cheie: cheieDenumire(denumire),
  };
}

// Dintre produsele deja existente, care e acelasi lucru cu ce s-a scris?
// Primeste randurile ca atare (id, denumire, fuzionat_in, activ) ca sa poata fi
// testata fara baza. Un produs fuzionat in altul nu se reutilizeaza: ar lega
// comanda de un id pe care motorul de fuziune l-a scos deja din joc.
function potrivire(existente, cheie) {
  for (const p of existente || []) {
    if (!p) continue;
    if (p.fuzionat_in) continue;
    if (Number(p.activ) === 0) continue;
    if (cheieDenumire(p.denumire) === cheie) return p;
  }
  return null;
}

module.exports = { cheieDenumire, validare, potrivire, LIMITE };
