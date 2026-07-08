equire('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const fs = require('fs');
const path = require('path');
 
const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
 
// ── DB ──────────────────────────────────────────────────────────────
const DB_FILE = '/tmp/plotmatch_db.json';
function readDB(){ try{ return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }catch(e){ return {requirements:[]}; } }
function writeDB(d){ fs.writeFileSync(DB_FILE,JSON.stringify(d,null,2)); }
function uid(){ return 'r'+Date.now()+Math.random().toString(36).slice(2,6); }
 
// ── HTTPS helper ─────────────────────────────────────────────────────
function httpsPost(hostname,urlPath,headers,bodyObj){
  return new Promise((resolve,reject)=>{
    const payload=JSON.stringify(bodyObj);
    const req=https.request({hostname,path:urlPath,method:'POST',headers:{...headers,'Content-Length':Buffer.byteLength(payload)}},(res)=>{
      let raw='';
      res.on('data',c=>raw+=c);
      res.on('end',()=>{ try{ resolve(JSON.parse(raw)); }catch(e){ reject(new Error('JSON fail: '+raw.slice(0,200))); } });
    });
    req.on('error',reject); req.write(payload); req.end();
  });
}
function httpsPostForm(hostname,urlPath,authHeader,formBody){
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname,path:urlPath,method:'POST',headers:{'Authorization':authHeader,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(formBody)}},(res)=>{
      let raw=''; res.on('data',c=>raw+=c); res.on('end',()=>{ console.log('[Twilio]',raw.slice(0,120)); resolve(raw); });
    });
    req.on('error',reject); req.write(formBody); req.end();
  });
}
 
// ── Claude: parse multiple listings ─────────────────────────────────
const PARSE_PROMPT = `You are an expert real-estate message interpreter for Faridabad/NCR, Haryana, India.
 
TYPE CLASSIFICATION:
"buy"       = wants to PURCHASE (chahiye, required, looking for, lena hai, buyer hai, confirm party)
"sell"      = wants to SELL (bechna hai, for sale, available for sale, deal for sale, rate/demand quoted)
"rent_want" = wants to RENT a place (required for rent, rent chahiye, budget X/month, location list as requirement)
"rent_have" = has property TO RENT OUT (available for rent, rent pe dena hai, kiraye pe)
 
CONTEXT SHIFT: If someone changed intent, extract CURRENT intent only. Note the shift in notes.
 
PRICE FORMATS:
- "@69000" after plot size = rate PER sq.yd. budgetMax = size x rate (200 gaj @69000 = 13800000)
- "2 lakh per sq yard" = rate per sq.yd, multiply by size
- "1.60/Sq.yd" = 1.60 lakh per sq.yd, multiply by size
- "Demand 63L" = total 63 lakh = 6300000
- Rent "20-30" or "20k-30k" = monthly rent budgetMin=20000 budgetMax=30000
- "3 Crore 70 Lakh" = 37000000
 
EXTRACTION RULES:
- Extract EACH property as its own separate object in the array
- Contact/agent name+phone at bottom of message applies to ALL listings in that message
- Multiple sectors as requirement (84/85/86/87/88) = locality "Sector 84-88 Faridabad"
- Notes field: include Stilt+4 approved, NOC status, Registry case, Joda/Pair plot, furnishing, road width, society/project name
- gaj=sq.yd. SF=sq.ft. Marla=272sq.ft. Kanal=20 marla.
 
RETURN ONLY raw JSON array, zero markdown, zero explanation:
[{"type":"buy|sell|rent_want|rent_have","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|Park-Facing","contact":"","notes":""}]
Always return array. Extract full name AND phone into contact field.`;
 
async function parseWithClaude(text){
  console.log('[Claude] Parsing:',text.slice(0,100));
  const result=await httpsPost('api.anthropic.com','/v1/messages',
    {'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    {model:'claude-sonnet-4-6',max_tokens:2000,system:PARSE_PROMPT,messages:[{role:'user',content:text}]}
  );
  if(!result.content) throw new Error('Claude error: '+JSON.stringify(result));
  const txt=result.content.map(b=>b.text||'').join('');
  const clean=txt.replace(/```json|```/g,'').trim();
  console.log('[Claude] Output:',clean.slice(0,200));
  const parsed=JSON.parse(clean);
  return Array.isArray(parsed)?parsed:[parsed];
}
 
// ── Claude: AI chat agent ────────────────────────────────────────────
const AGENT_PROMPT = `You are PlotMatch AI, a smart real-estate assistant for Faridabad/NCR, Haryana, India.
You help a real-estate consultant manage buy/sell/rent requirements.
You have access to the current database of requirements passed to you.
You understand all local terminology: gaj, sq.yd, marla, kanal, biswa, sector, HUDA, HSVP, 
builder floor, file, registry, CLU, north/south/east/west facing, BHK, kothi, etc.
You can:
- Answer questions about the database ("how many buyers in sector 21?", "any match for 250 gaj plot?")
- Explain matches and why they qualify
- Suggest which entries to follow up on
- Calculate area conversions (1 marla = 272.25 sq.ft, 1 kanal = 20 marla = 5445 sq.ft, 1 gaj = 9 sq.ft)
- Help interpret WhatsApp messages
- Give market insights for Faridabad NCR
Be concise, smart, and use ₹ for currency. Respond in the same language the user uses (Hindi/English/Hinglish).`;
 
async function chatWithAgent(userMessage, dbSnapshot){
  const contextMsg = `Current database has ${dbSnapshot.length} requirements:\n${JSON.stringify(dbSnapshot.slice(0,50),null,1)}\n\nUser: ${userMessage}`;
  const result=await httpsPost('api.anthropic.com','/v1/messages',
    {'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    {model:'claude-sonnet-4-6',max_tokens:1000,system:AGENT_PROMPT,messages:[{role:'user',content:contextMsg}]}
  );
  if(!result.content) throw new Error('Claude agent error: '+JSON.stringify(result));
  return result.content.map(b=>b.text||'').join('');
}
 
// ── Twilio ───────────────────────────────────────────────────────────
async function sendWA(to,body){
  console.log('[WA] To:',to,'|',body.slice(0,80));
  if(!TWILIO_ACCOUNT_SID||!TWILIO_AUTH_TOKEN||!TWILIO_WHATSAPP_FROM){ console.log('[WA] No creds'); return; }
  const form=new URLSearchParams({From:TWILIO_WHATSAPP_FROM,To:to,Body:body}).toString();
  const auth='Basic '+Buffer.from(TWILIO_ACCOUNT_SID+':'+TWILIO_AUTH_TOKEN).toString('base64');
  await httpsPostForm('api.twilio.com',`/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,auth,form);
}
 
// ── Matchmaking ───────────────────────────────────────────────────────
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function fmtINR(n){ if(!n) return ''; if(n>=10000000) return '₹'+(n/10000000).toFixed(2).replace(/\.?0+$/,'')+' Cr'; if(n>=100000) return '₹'+(n/100000).toFixed(1).replace(/\.?0+$/,'')+' L'; return '₹'+n; }
function fmtBudget(min,max){ if(min&&max) return fmtINR(min)+'–'+fmtINR(max); if(max) return 'up to '+fmtINR(max); if(min) return fmtINR(min)+'+'; return ''; }
function summarize(i){ return [i.type?.toUpperCase(),i.category,i.bhk,i.locality,i.subLocality,i.size&&i.size+' '+i.unit,i.facing&&i.facing+' facing',fmtBudget(i.budgetMin,i.budgetMax),i.contact,i.notes].filter(Boolean).join(' | '); }
function shortLabel(i){ return (i.contact||i.id)+' — '+(i.category||'Property')+(i.bhk?' '+i.bhk:'')+' in '+(i.locality||'n/a'); }
function isMatch(buyer,seller){
  const lb=norm(buyer.locality),ls=norm(seller.locality);
  if(!lb||!ls||!(lb===ls||lb.includes(ls)||ls.includes(lb))) return false;
  if(buyer.category&&seller.category&&buyer.category!==seller.category) return false;
  const bMax=buyer.budgetMax||buyer.budgetMin, sAsk=seller.budgetMax||seller.budgetMin;
  if(!bMax||!sAsk) return false;
  return bMax>=sAsk*0.95;
}
function findMatches(newItem,all){
  const opp=newItem.type==='buy'?all.filter(d=>d.type==='sell'&&d.id!==newItem.id)
    :newItem.type==='sell'?all.filter(d=>d.type==='buy'&&d.id!==newItem.id)
    :all.filter(d=>d.type==='rent'&&d.id!==newItem.id);
  const hits=[];
  for(const c of opp){
    const buyer=newItem.type==='sell'?c:newItem, seller=newItem.type==='sell'?newItem:c;
    if(isMatch(buyer,seller)) hits.push({buyer,seller});
  }
  return hits;
}
 
// ── Express ───────────────────────────────────────────────────────────
const app=express();
app.use((req,res,next)=>{ res.header('Access-Control-Allow-Origin','*'); res.header('Access-Control-Allow-Headers','Content-Type'); res.header('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS'); next(); });
app.options('*',(req,res)=>res.sendStatus(200));
app.use(bodyParser.urlencoded({extended:false}));
app.use(bodyParser.json());
 
app.get('/',(_, res)=>res.send('PlotMatch API live ✅'));
 
// Get all requirements
app.get('/requirements',(_, res)=>res.json(readDB().requirements));
 
// Delete a requirement
app.delete('/requirements/:id',(req,res)=>{
  const data=readDB();
  data.requirements=data.requirements.filter(d=>d.id!==req.params.id);
  writeDB(data);
  res.json({success:true});
});
 
// Add from dashboard manually
app.post('/add',async(req,res)=>{
  try{
    const body=req.body;
    const item={
      id:uid(), type:body.type||'buy', category:body.category||'', bhk:body.bhk||'',
      locality:body.locality||'', subLocality:body.subLocality||'',
      size:parseFloat(body.size)||null, unit:body.unit||'',
      budgetMin:parseFloat(body.budgetMin)||null, budgetMax:parseFloat(body.budgetMax)||null,
      facing:body.facing||'', contact:body.contact||'', notes:body.notes||'',
      rawText:body.rawText||'', source:'dashboard', createdAt:Date.now()
    };
    const data=readDB();
    const hits=findMatches(item,data.requirements);
    data.requirements.unshift(item);
    writeDB(data);
    res.json({success:true,item,matches:hits});
  }catch(err){ res.status(500).json({success:false,error:err.message}); }
});
 
// AI chat agent endpoint
app.post('/chat',async(req,res)=>{
  try{
    const {message}=req.body;
    if(!message) return res.status(400).json({error:'No message'});
    const data=readDB();
    const reply=await chatWithAgent(message,data.requirements);
    res.json({reply});
  }catch(err){
    console.error('[Chat]',err.message);
    res.status(500).json({error:err.message});
  }
});
 
// WhatsApp webhook
app.post('/webhook',async(req,res)=>{
  res.status(200).set('Content-Type','text/xml').send('<Response></Response>');
  const msgBody=(req.body.Body||'').trim();
  const from=req.body.From||'';
  const name=req.body.ProfileName||'';
  console.log(`[Webhook] From:${from} (${name}) | Body:${msgBody.slice(0,120)}`);
  if(!msgBody) return;
  try{
    const listings=await parseWithClaude(msgBody);
    console.log(`[Webhook] ${listings.length} listing(s) parsed`);
    const data=readDB();
    const matchAlerts=[];
    for(const listing of listings){
      const item={
        id:uid(), type:listing.type||'sell', category:listing.category||'', bhk:listing.bhk||'',
        locality:listing.locality||'', subLocality:listing.subLocality||'',
        size:listing.size||null, unit:listing.unit||'',
        budgetMin:listing.budgetMin||null, budgetMax:listing.budgetMax||null,
        facing:listing.facing||'', contact:listing.contact||name||from,
        notes:listing.notes||'', rawText:msgBody, source:from, createdAt:Date.now()
      };
      const hits=findMatches(item,data.requirements);
      data.requirements.unshift(item);
      if(hits.length>0){
        for(const hit of hits){
          matchAlerts.push(`🎯 MUTUAL MATCH!\n\nBUYER: ${shortLabel(hit.buyer)}\n${summarize(hit.buyer)}\n\nSELLER: ${shortLabel(hit.seller)}\n${summarize(hit.seller)}\n\n✅ Connect them now!`);
        }
      }
    }
    writeDB(data);
    if(matchAlerts.length>0){
      await sendWA(from,matchAlerts.join('\n\n─────\n\n'));
    }else{
      const saved=listings.map(l=>`• ${(l.type||'').toUpperCase()} ${l.category||''} ${l.bhk||''} ${l.locality||''} ${l.size?l.size+' '+l.unit:''} ${fmtBudget(l.budgetMin,l.budgetMax)}`).join('\n');
      await sendWA(from,`✅ Saved ${listings.length} listing(s):\n${saved}\n\nNo match yet — will notify instantly when one arrives.`);
    }
  }catch(err){
    console.error('[Webhook Error]',err.message);
    await sendWA(from,`⚠️ Error: ${err.message.slice(0,100)}`);
  }
});
 
app.listen(PORT,()=>{
  console.log(`\n✅ PlotMatch running on port ${PORT}`);
  console.log(`   ANTHROPIC_API_KEY : ${ANTHROPIC_API_KEY?'SET ✓':'MISSING ✗'}`);
  console.log(`   TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID?'SET ✓':'MISSING ✗'}`);
  console.log(`   TWILIO_AUTH_TOKEN : ${TWILIO_AUTH_TOKEN?'SET ✓':'MISSING ✗'}`);
  console.log(`   TWILIO_WA_FROM    : ${TWILIO_WHATSAPP_FROM||'MISSING ✗'}\n`);
});
