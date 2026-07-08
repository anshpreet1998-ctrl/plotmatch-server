require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
 
const PORT = process.env.PORT || 10000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
 
// ── IN-MEMORY INBOX (WhatsApp messages waiting for dashboard to pick up)
let inbox = [];
let processedCount = 0;
 
// ── HTTPS helpers ──────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => { let r = ''; res.on('data', c => r += c); res.on('end', () => { try { resolve(JSON.parse(r)); } catch(e) { reject(new Error(r.slice(0,200))); } }); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}
 
function httpsPostForm(hostname, path, auth, form) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } },
      res => { let r = ''; res.on('data', c => r += c); res.on('end', () => resolve(r)); }
    );
    req.on('error', reject); req.write(form); req.end();
  });
}
 
// ── Claude parser ──────────────────────────────────────────────────────
const PARSE_PROMPT = `You are an expert real-estate message interpreter for Faridabad/NCR, Haryana, India.
 
TYPE CLASSIFICATION:
"buy"       = wants to PURCHASE (chahiye, required, looking for, lena hai, buyer hai, confirm party)
"sell"      = wants to SELL (bechna hai, for sale, available for sale, deal for sale, rate/demand quoted)
"rent_want" = wants to RENT a place (required for rent, rent chahiye, budget X/month, location list as requirement)
"rent_have" = has property TO RENT OUT (available for rent, rent pe dena hai, kiraye pe)
 
CONTEXT SHIFT: If someone changed intent (pehle rent chahiye tha ab bech raha hai), extract CURRENT intent only. Note the shift.
 
PRICE FORMATS:
- "@69000" after plot size = rate PER sq.yd. budgetMax = size x rate (200 gaj @69000 = 13800000)
- "2 lakh per sq yard" = rate per sq.yd, multiply by size
- "1.60/Sq.yd" = 1.60 lakh per sq.yd, multiply by size
- "Demand 63L" = total 63 lakh = 6300000
- Rent "20-30" = monthly rent budgetMin=20000 budgetMax=30000
- "3 Crore 70 Lakh" or "3.70 Cr" = 37000000
 
EXTRACTION RULES:
- Extract EACH property as its own object. Contact at bottom applies to ALL listings.
- Multiple sectors as requirement (84/85/86/87/88) = locality "Sector 84-88 Faridabad"
- Notes: Stilt+4 approved, NOC, Registry case, Joda/Pair, furnishing, road width, society/project name
- gaj=sq.yd. SF=sq.ft. Marla=272sq.ft. Kanal=20 marla.
 
RETURN ONLY raw JSON array, zero markdown:
[{"type":"buy|sell|rent_want|rent_have","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|Park-Facing","contact":"","notes":""}]
Always return array. Extract full name AND phone into contact field.`;
 
async function parseWithClaude(text) {
  const result = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-6', max_tokens: 2000, system: PARSE_PROMPT, messages: [{ role: 'user', content: text }] }
  );
  if (!result.content) throw new Error('Claude error: ' + JSON.stringify(result).slice(0, 200));
  const txt = result.content.map(b => b.text || '').join('');
  const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}
 
// ── Twilio send ────────────────────────────────────────────────────────
async function sendWA(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.log('[WA skipped - no creds]', body.slice(0, 80)); return;
  }
  const form = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: body }).toString();
  const auth = 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
  await httpsPostForm('api.twilio.com', `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, auth, form);
}
 
// ── Express ────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  next();
});
app.options('*', (_, res) => res.sendStatus(200));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
 
// Health check
app.get('/', (_, res) => res.json({
  status: 'PlotMatch running ✅',
  inbox: inbox.length,
  processed: processedCount
}));
 
// Dashboard polls this to get new WhatsApp messages
app.get('/inbox', (req, res) => {
  const items = [...inbox];
  inbox = []; // clear after delivery
  res.json({ items, count: items.length });
});
 
// Dashboard can also push entries (for server-side matching notification)
app.post('/notify', async (req, res) => {
  // Future: server notifies matched parties via WhatsApp
  res.json({ ok: true });
});
 
// WhatsApp webhook from Twilio
app.post('/webhook', async (req, res) => {
  res.status(200).set('Content-Type', 'text/xml').send('<Response></Response>');
  const msgBody = (req.body.Body || '').trim();
  const from = req.body.From || '';
  const name = req.body.ProfileName || '';
  console.log(`[WA] From: ${from} (${name}) | ${msgBody.slice(0, 100)}`);
  if (!msgBody) return;
 
  try {
    const listings = await parseWithClaude(msgBody);
    console.log(`[WA] Parsed ${listings.length} listing(s)`);
 
    // Add to inbox for dashboard to pick up
    inbox.push({
      id: 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      listings,
      rawText: msgBody,
      from,
      name,
      receivedAt: Date.now()
    });
    processedCount++;
 
    // Reply to sender
    const summary = listings.map(l =>
      `• ${(l.type||'').replace('_',' ').toUpperCase()} ${l.category||''} ${l.bhk||''} ${l.locality||''} ${l.size ? l.size+' '+l.unit : ''} ${l.budgetMax ? '₹'+formatINR(l.budgetMax) : ''}`
    ).join('\n');
    await sendWA(from, `✅ Received ${listings.length} listing(s):\n${summary}\n\nSaved to PlotMatch dashboard.`);
  } catch (err) {
    console.error('[WA Error]', err.message);
    await sendWA(from, `⚠️ Could not read message: ${err.message.slice(0, 80)}`);
  }
});
 
function formatINR(n) {
  if (!n) return '';
  if (n >= 10000000) return (n/10000000).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 100000) return (n/100000).toFixed(1).replace(/\.?0+$/, '') + ' L';
  return n.toString();
}
 
app.listen(PORT, () => {
  console.log(`\n✅ PlotMatch server on port ${PORT}`);
  console.log(`   ANTHROPIC_API_KEY : ${ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_AUTH_TOKEN : ${TWILIO_AUTH_TOKEN ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_WA_FROM    : ${TWILIO_WHATSAPP_FROM || 'MISSING ✗'}\n`);
});
 
