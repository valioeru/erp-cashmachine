"use strict";

// Ce intră, de fapt, într-un cont din balanță — scris pe înțelesul cuiva care
// conduce firma, nu al contabilei. Denumirea oficială („Alte cheltuieli de
// exploatare") nu spune nimic despre ce pui acolo; explicația de aici spune.
//
// Potrivirea se face pe PREFIXUL CEL MAI LUNG: 6022 își ia rândul lui, 6027
// (care nu există în listă) cade pe 602, iar un cont necunoscut din clasa 6
// cade pe „6". Așa nu rămâne niciun cont fără explicație, oricât de exotic ar
// fi analiticul inventat de contabilă.
//
// Nu e consultanță fiscală: e unde-și ține firma asta cifrele. Dacă un cont e
// folosit altfel în Conta, explicația de aici rămâne doar un indiciu.
const EXPLICATII = {
  // ---- clasa 6: cheltuieli ---------------------------------------------------
  "6": "Cheltuială. Orice consumi ca să meargă firma.",
  "60": "Cumpărături: marfă, materiale, utilități — ce intră în firmă și se consumă.",
  "601": "Ce intră efectiv în produsul fabricat: hârtie, carton, folie. Nu marfa luată ca s-o revinzi — aia e 607.",
  "602": "Ce se consumă ca să meargă treaba, fără să devină produsul vândut.",
  "6021": "Adezivi, cerneluri, benzi, sfoară — ajută la fabricație, dar nu sunt produsul.",
  "6022": "Motorină și benzină pentru mașini și utilaje, gaz pe factură de combustibil.",
  "6024": "Piese pentru utilaje și mașini, cumpărate ca să repari — nu ca să revinzi.",
  "6028": "Consumabile de birou și curățenie, ambalaje mărunte, restul de mărunțișuri.",
  "603": "Scule, rafturi, scaune, echipament: țin mai mult de un an, dar sunt prea ieftine ca să fie mijloc fix.",
  "604": "Ce cumperi și consumi pe loc, fără să treacă prin stoc: tipărituri, materiale de întreținere.",
  "605": "Facturile de utilități.",
  "6051": "Curentul electric.",
  "6052": "Apa și canalizarea.",
  "6058": "Gaz, salubritate, restul utilităților.",
  "607": "Cât ai plătit furnizorului pentru marfa pe care ai vândut-o. Cel mai mare cost al firmei, se mișcă odată cu vânzările.",
  "608": "Ambalajele returnate furnizorului, scăzute din cheltuială.",
  "609": "Discounturile primite de la furnizori DUPĂ factură. Scad cheltuiala, de-aia sunt cu minus.",
  "61": "Servicii cumpărate de la alții: chirii, reparații, asigurări.",
  "611": "Reparații la clădiri, utilaje, mașini — făcute de alții, pe factură.",
  "612": "Chirii și redevențe.",
  "6123": "Chiria pentru spații, depozite, mașini, utilaje.",
  "613": "RCA, CASCO, asigurarea clădirii și a mărfii.",
  "614": "Studii și cercetări comandate în afară.",
  "615": "Cursuri, instruiri, autorizări pentru oameni.",
  "617": "Facturile de management și administrare, de la altă firmă din grup sau de la un terț.",
  "62": "Servicii de la terți: comisioane, publicitate, transport, telefoane, bancă.",
  "622": "Contabilitate, avocat, consultanță, comisioane de intermediere.",
  "623": "Protocol, reclamă, publicitate.",
  "6231": "Mese cu clienții, cadouri, atenții.",
  "6232": "Campanii, reclamă online, tipărituri promoționale, materiale de prezentare.",
  "624": "Transportul mărfii cu firme de transport sau curieri, când plătești tu transportul. Și transportul personalului.",
  "625": "Delegații: diurnă, cazare, bilete, combustibil pe drum.",
  "626": "Telefoane, internet, poștă, curierat de documente.",
  "627": "Comisioanele băncii: de cont, de tranzacție, de retragere. NU dobânzile — alea sunt 666.",
  "628": "Pază, curățenie, IT, abonamente software — serviciile care n-au cont al lor.",
  "63": "Impozite și taxe, altele decât impozitul pe profit.",
  "635": "Impozit pe clădiri și teren, taxe auto, taxe locale, timbru de mediu.",
  "64": "Tot ce costă oamenii: salarii, contribuții, tichete.",
  "641": "Salariile brute ale angajaților, înainte de rețineri.",
  "642": "Ce le mai dai peste salariu.",
  "6421": "Tichetele de masă.",
  "6422": "Primele din participarea salariaților la profit.",
  "645": "Contribuțiile pe care le suportă FIRMA peste salariu.",
  "6451": "Contribuția de asigurări sociale (pensii) suportată de firmă.",
  "6453": "Contribuția de asigurări sociale de sănătate suportată de firmă.",
  "6458": "Alte contribuții și ajutoare: concedii medicale, protecție socială.",
  "6461": "Contribuția asiguratorie pentru muncă — cea de 2,25% pe care o plătește firma peste salarii.",
  "65": "Cheltuieli de exploatare care nu se leagă de marfă, oameni sau servicii.",
  "658": "Despăgubiri, amenzi, sponsorizări și restul.",
  "6581": "Amenzi, penalități de întârziere, despăgubiri plătite.",
  "6583": "Cât mai era neamortizat din mijloacele fixe vândute sau casate.",
  "6584": "Sponsorizări și bunuri date gratuit.",
  "6588": "Ce nu încape nicăieri altundeva: lipsuri la inventar, mărunțișuri, diverse.",
  "66": "Costul banilor: dobânzi, curs valutar, comisioane de finanțare.",
  "665": "Pierderile din cursul valutar.",
  "6651": "Pierderea din curs la plăți și încasări în valută.",
  "666": "Dobânzile la credite, leasinguri și linii de credit.",
  "667": "Sconturi acordate clienților pentru plata înainte de termen.",
  "668": "Restul costurilor financiare.",
  "68": "Amortizări și provizioane — cheltuieli care nu sunt plăți.",
  "681": "Uzura scrisă în contabilitate a lucrurilor pe care le ai.",
  "6811": "Uzura anuală a utilajelor, mașinilor, amenajărilor. Nu iese niciun leu din cont, dar scade profitul.",
  "69": "Impozitul pe rezultat.",
  "691": "Impozitul pe profit.",
  "698": "Impozitul pe venitul microîntreprinderii.",

  // ---- clasa 7: venituri -----------------------------------------------------
  "7": "Venit. Ce facturezi.",
  "70": "Cifra de afaceri: marfă, produse, servicii facturate clienților.",
  "701": "Vânzarea produselor fabricate de tine.",
  "7015": "Produsele făcute de tine și vândute: pungi, cutii.",
  "703": "Deșeuri și rebuturi vândute: carton, folie, capete de material.",
  "704": "Manopera și serviciile facturate clienților: depozitare, manipulare, fasonare.",
  "706": "Ce încasezi din închirieri și redevențe.",
  "707": "Vânzarea mărfii cumpărate ca s-o revinzi — grosul cifrei de afaceri.",
  "708": "Ce refacturezi clientului pe lângă marfă: transport, ambalaje, servicii accesorii.",
  "709": "Discounturile date clienților DUPĂ factură. Scad cifra de afaceri, de-aia sunt cu minus.",
  "71": "Variația stocului de produse — ajustare contabilă, nu bani încasați.",
  "711": "Diferența dintre cât ai produs și cât ai vândut din producție. Nu intră bani în cont.",
  "74": "Subvenții.",
  "741": "Subvențiile primite din exploatare.",
  "75": "Venituri de exploatare care nu vin din vânzări.",
  "758": "Vânzări de active, despăgubiri primite, diverse.",
  "7583": "Prețul la care ai vândut mijloace fixe (mașini, utilaje).",
  "7588": "Restul veniturilor din exploatare: despăgubiri încasate, diverse.",
  "76": "Venituri financiare: dobânzi, curs valutar.",
  "765": "Câștigurile din cursul valutar.",
  "7651": "Câștigul din curs la plăți și încasări în valută.",
  "766": "Dobânzile încasate la depozite și conturi.",
  "767": "Sconturi primite de la furnizori pentru plata înainte de termen.",
  "768": "Restul veniturilor financiare.",
};

// Prefixul cel mai lung câștigă: 6022 își ia rândul lui, 6027 cade pe 602.
function explicatia(cont) {
  const c = String(cont || "").trim();
  if (!c) return "";
  for (let n = c.length; n >= 1; n--) {
    const cheie = c.slice(0, n);
    if (EXPLICATII[cheie]) return EXPLICATII[cheie];
  }
  return "";
}

module.exports = { EXPLICATII, explicatia };
