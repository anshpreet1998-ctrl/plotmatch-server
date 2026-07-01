require('dotenv').config();
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
 
// ---------- plain JSON database ----------
const DB_FILE = path.join('/tmp', 'db.json');
function readDB(){ try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e){ return { requirements:[] }; } }
function writeDB(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function uid(){ return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }
 
// ---------- generic HTTPS POST helper ----------
function httpsPost(hostname, path, headers, body){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method:'POST', headers:{ ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e){ reject(new Error('Bad JSON: '+raw.slice(0,200))); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
 
// ---------- Claude parsing ----------
const SYSTEM_PROMPT = `You are a real-estate data extraction agent for Faridabad, Haryana (NCR India). Extract ONE structured requirement from a WhatsApp message in Hindi/English/Hinglish.
 
You understand: plot, floor, flat, builder floor, kothi, file (unregistered allotment paper), BHK, sq.yd/gaj (same unit), marla, kanal, biswa, acre, sq.ft, corner plot, park-facing, north/south/east/west facing, registry, CLU, HUDA/HSVP sectors, cr/crore, lac/lakh.
 
Respond ONLY with raw JSON, no markdown, no prose:
{"type":"buy|sell|rent","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","size":null,"unit":"sq.yd|marla|kanal|sq.ft|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|","contact":"","notes":""}
 
Rules: 1.5 cr = 15000000, 50 lac = 5000000. gaj = sq.yd. "chahiye/looking for/required" = buy. "available/for sale/bechna hai" = sell. Single budget = budgetMax.`;
 
async function parseWithClaude(text){
  const result = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    { model:'claude-sonnet-4-6', max_tokens:800, system: SYSTEM_PROMPT, messages:[{ role:'user', content: text }] }
  );
  if(!result.content) throw new Error('Claude error: '+JSON.stringify(result));
  const text2 = result.content.map(b=>b.text||'').join('');
  return JSON.parse(text2.replace(/```json|```/g,'').trim());
}
 
// ---------- Twilio WhatsApp ----------
async function sendWhatsApp(to, body){
  if(!TWILIO_ACCOUNT_SID||!TWILIO_AUTH_TOKEN||!TWILIO_WHATSAPP_FROM){ console.log('[WA]',to,body); return; }
  const auth = Buffer.from(TWILIO_ACCOUNT_SID+':'+TWILIO_AUTH_TOKEN).toString('base64');
  const params = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: body }).toString();
  return new Promise((resolve,reject)=>{
    const req = https.request({
      hostname:'api.twilio.com',
      path:`/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      method:'POST',
      headers:{ 'Authorization':'Basic '+auth, 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(params) }
    }, res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>resolve(r)); });
    req.on('error',reject);
    req.write(params);
    req.end();
  });
}
 
// ---------- matchmaking ----------
function normLoc(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function fmtINR(n){
  if(!n) return null;
  if(n>=10000000) return '₹'+(n/10000000).toFixed(2)+' Cr';
  if(n>=100000) return '₹'+(n/100000).toFixed(1)+' L';
  return '₹'+n;
}
function fmtBudget(min,max){ return max?(min?fmtINR(min)+' – '+fmtINR(max):'up to '+fmtINR(max)):(min?fmtINR(min)+'+':'n/a'); }
function summarize(i){ return [i.category,i.bhk,i.locality&&'in '+i.locality,i.size&&i.size+' '+i.unit,i.facing&&i.facing+' facing',fmtBudget(i.budgetMin,i.budgetMax)].filter(Boolean).join(', '); }
function shortLabel(i){ return (i.contact||i.id)+' — '+(i.category||'Property')+(i.bhk?' '+i.bhk:'')+' in '+(i.locality||'n/a'); }
function strictCompatible(buyer,seller){
  const lb=normLoc(buyer.locality),ls=normLoc(seller.locality);
  if(!lb||!ls||!(lb===ls||lb.includes(ls)||ls.includes(lb))) return false;
  if(buyer.category&&seller.category&&buyer.category!==seller.category) return false;
  const bMax=buyer.budgetMax||buyer.budgetMin, sAsk=seller.budgetMax||seller.budgetMin;
  if(!bMax||!sAsk) return false;
  return bMax>=sAsk*0.95;
}
function runMatchEngine(newItem,all){
  const opp=newItem.type==='buy'?all.filter(d=>d.type==='sell'&&d.id!==newItem.id)
    :newItem.type==='sell'?all.filter(d=>d.type==='buy'&&d.id!==newItem.id)
    :all.filter(d=>d.type==='rent'&&d.id!==newItem.id);
  for(const c of opp){
    const buyer=newItem.type==='sell'?c:newItem, seller=newItem.type==='sell'?newItem:c;
    if(strictCompatible(buyer,seller)) return {buyer,seller};
  }
  return null;
}
 
// ---------- Express ----------
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());
 
app.get('/', (_,res) => res.send('PlotMatch is running ✅'));
app.get('/requirements', (_,res) => res.json(readDB().requirements));
 
app.post('/webhook', async (req,res) => {
  const body = req.body.Body||'';
  const from = req.body.From||'';
  const profileName = req.body.ProfileName||'';
  res.status(200).send('<Response></Response>');
  if(!body.trim()) return;
  try {
    const parsed = await parseWithClaude(body);
    const item = { id:uid(), type:'buy', category:'', bhk:'', locality:'', size:null, unit:'', budgetMin:null, budgetMax:null, facing:'', contact:profileName||from, notes:'', rawText:body, source:from, createdAt:Date.now(), ...parsed, contact:parsed.contact||profileName||from, rawText:body, source:from };
    const data = readDB();
    const hit = runMatchEngine(item, data.requirements);
    data.requirements.unshift(item);
    writeDB(data);
    if(hit){
      await sendWhatsApp(from, `🎯 MUTUAL MATCH IDENTIFIED!\n\nBuyer: ${shortLabel(hit.buyer)}\n${summarize(hit.buyer)}\n\nSeller: ${shortLabel(hit.seller)}\n${summarize(hit.seller)}\n\nLocality & budget align — connect them now!`);
    } else {
      await sendWhatsApp(from, `✅ Saved: ${summarize(item)}\n\nNo match yet. You'll be notified the moment a compatible entry comes in.`);
    }
  } catch(err){
    console.error('Webhook error:', err.message);
    await sendWhatsApp(from, `⚠️ Could not parse: "${body.slice(0,60)}..."\nTry rephrasing or add manually.`);
  }
});
 
app.listen(PORT, () => console.log(`PlotMatch listening on port ${PORT} ✅`));
 
