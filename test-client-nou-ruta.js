"use strict";
// Ruta prin care intră clientul scris pe loc. Cu o bază falsă.
//
// CE APĂRĂ:
//
//   • CLIENTUL INTRĂ PE NUMELE CELUI CARE ÎL SCRIE. Altfel firma rămâne „a
//     nimănui": nu apare în lista agentului, iar scadențele ei n-au pe cine
//     să blocheze. Asta a cerut Vali explicit.
//
//   • DAR NU SE FURĂ CLIENTUL COLEGULUI. O firmă care are deja un agent
//     rămâne a lui, oricine ar scrie comanda următoare.
//
//   • UN FURNIZOR CARE ÎNCEPE SĂ CUMPERE DEVINE „AMBELE", NU AL DOILEA RÂND.
//     A doua fișă pe același CUI rupe soldul firmei în două.
//
//   • UN CUI GREȘIT NU INTRĂ ÎN BAZĂ. O cifră tastată strâmb face o firmă
//     nouă care arată exact ca una adevărată.
const Module = require("module");
const R = __dirname;
const BAZA = { parteneri: [
  { id: 3, nume: "Sameday Courier SRL", cui: "RO34765521", tip: "client", agent_id: 22 },
  { id: 5, nume: "Furnizor Vechi", cui: "14399840", tip: "furnizor", agent_id: null },
], scrieri: [] };
let urm = 100;
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get() { return undefined; },
    async all() { if (/FROM parteneri/i.test(s)) return BAZA.parteneri.map(p => ({...p})); return []; },
    async run(...a) {
      BAZA.scrieri.push(s);
      if (/INSERT INTO parteneri/i.test(s)) {
        const id = ++urm;
        BAZA.parteneri.push({ id, tip: "client", nume: a[0], cui: a[1], email: a[2], telefon: a[3],
          persoana_contact: a[4], adresa: a[5], sursa: a[6], agent_id: a[7] });
        return { lastInsertRowid: id };
      }
      if (/UPDATE parteneri SET tip = 'ambele'/i.test(s)) { const p = BAZA.parteneri.find(x=>x.id===Number(a[0])); if (p) p.tip = "ambele"; }
      if (/UPDATE parteneri SET agent_id/i.test(s)) { const p = BAZA.parteneri.find(x=>x.id===Number(a[1])); if (p) p.agent_id = a[0]; }
      return { lastInsertRowid: 0 };
    },
  };
}
function inj(c,o){const x=require.resolve(c);const m=new Module(x,null);m.filename=x;m.loaded=true;m.exports=o;require.cache[x]=m;}
inj(R+"/lib/db", { prepare: fals, exec: async()=>{}, migrate: async()=>{} });
const mod = require(R+"/modules/parteneri");
const rute = [];
mod.register({ get:(c,h)=>rute.push(["GET",c,h]), post:(c,h)=>rute.push(["POST",c,h]), use:()=>{} });
const h = rute.find(r=>r[0]==="POST" && r[1]==="/parteneri/rapid")[2];
async function cheama(corp, user) {
  let stare=200, text="";
  const res={ writeHead(s){stare=s;}, end(t){text=String(t||"");}, setHeader(){} };
  await h({ req:{}, res, params:{}, query:{}, body:corp, user });
  let j=null; try{ j=JSON.parse(text);}catch(e){}
  return { stare, j };
}
const AGENT = { id: 44, nume: "Agent Nou", rol: "agent" };
(async () => {
  let e = 0;
  const bine=(d,c,det)=>{ if(c) console.log("  ok     "+d); else { console.log("  ESEC   "+d+(det!==undefined?"  -> "+JSON.stringify(det).slice(0,200):"")); e++; } };

  console.log("Clientul chiar nou");
  let r = await cheama({ nume:"Firma Chiar Noua SRL", cui:"RO1590082", telefon:"0722000000" }, AGENT);
  bine("se scrie", r.stare===200 && r.j.id>0, r.j);
  bine("NU e marcat ca reutilizat", r.j.reutilizat === false);
  const p = BAZA.parteneri.find(x=>x.id===r.j.id);
  bine("intra ca CLIENT", p.tip==="client", p.tip);
  bine("pe numele agentului care l-a scris", Number(p.agent_id)===44, p.agent_id);
  bine("cu sursa „comanda”", p.sursa==="comandă", p.sursa);
  bine("CUI-ul scris doar cu cifre", p.cui==="1590082", p.cui);

  console.log("Dubluri");
  const cate = BAZA.parteneri.length;
  // CUI-ul e obligatoriu, deci potrivirea pe NUME se intampla cand CUI-ul
  // scris nu e al nimanui, dar numele e. Cazul real: firma veche intrata
  // fara CUI, sau agentul care scrie CUI-ul corect peste unul vechi lipsa.
  r = await cheama({ nume:"S.C. SAMEDAY COURIER S.R.L.", cui:"RO5022670" }, AGENT);
  bine("firma care exista se gaseste dupa nume", r.j.reutilizat===true && r.j.id===3, r.j);
  bine("si NU se scrie a doua oara", BAZA.parteneri.length===cate, BAZA.parteneri.length);
  bine("se spune ca e a altui agent", r.j.alAltuia===true, r.j);
  bine("si NU i se fura clientul colegului", BAZA.parteneri.find(x=>x.id===3).agent_id===22);

  console.log("Furnizorul care incepe sa cumpere");
  r = await cheama({ nume:"Altceva SRL", cui:"RO14399840" }, AGENT);
  bine("se gaseste dupa CUI", r.j.reutilizat===true && r.j.id===5, r.j);
  bine("devine «ambele», nu al doilea rand", BAZA.parteneri.find(x=>x.id===5).tip==="ambele");
  bine("si firma fara stapan se ia de cine o aduce", Number(BAZA.parteneri.find(x=>x.id===5).agent_id)===44);

  console.log("Ce se refuza");
  const c2 = BAZA.parteneri.length;
  r = await cheama({ nume:"Fara CUI SRL", cui:"" }, AGENT);
  bine("fara CUI nu trece", r.stare===400 && r.j.gresite.length>0, r.j);
  r = await cheama({ nume:"Cu CUI Gresit SRL", cui:"RO14399841" }, AGENT);
  bine("un CUI cu o cifra gresita nu trece", r.stare===400 && /control/.test(r.j.gresite[0]), r.j);
  bine("si nimic n-a intrat in baza", BAZA.parteneri.length===c2, BAZA.parteneri.length);
  r = await cheama({ nume:"X SRL", cui:"RO1590082" }, null);
  bine("nelogat nu poate", r.stare===401);
  console.log(e ? "\n"+e+" cazute." : "\nToate trec.");
  process.exit(e?1:0);
})().catch(x=>{console.error("CRAPAT:",x.stack||x);process.exit(1);});
