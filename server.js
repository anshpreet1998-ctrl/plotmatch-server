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
 
// ── DB ──────────────────────────────────────────────────────────────
const DB_FILE = '/tmp/plotmatch_db.json';
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return { requirements: [] }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function uid() { return 'r' + Date.now() + Math.random().toString(36).slice(2,6); }
 
// ── HTTPS helper ─────────────────────────────────────────────────────
function httpsPost(hostname, urlPath, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const options = {
      hostname, path: urlPath, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('JSON parse fail: ' + raw.slice(0,300))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
 
function httpsPostForm(hostname, urlPath, authHeader, formBody) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, path: urlPath, method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody)
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { console.log('[Twilio response]', raw.slice(0,200)); resolve(raw); });
    });
    req.on('error', e => { console.error('[Twilio error]', e); reject(e); });
    req.write(formBody);
    req.end();
  });
}
 
// ── Claude: parse MULTIPLE listings from one message ─────────────────
const SYSTEM_PROMPT = `You are a real-estate AI for Faridabad/NCR, Haryana, India.
 
Extract ALL property listings from the message. Each listing is a separate buy/sell/rent entry.
You understand: plot, floor, flat, builder floor, kothi, file, BHK, sq.yd/gaj (same=sq.yd), sqft/sq.ft, marla, kanal, corner, park-facing, north/south/east/west facing, registry, CLU, HUDA/HSVP, sector numbers, cr/crore, lac/lakh, L Block/C Block etc as sub-localities.
 
RESPOND ONLY with a raw JSON array (no markdown, no explanation):
[
  {
    "type": "buy or sell or rent",
    "category": "Plot or Floor or Flat or House or Shop or Office or Other",
    "bhk": "e.g. 3BHK or 2nd floor or empty string",
    "locality": "area/sector name",
    "subLocality": "block/sector sub-area if mentioned",
    "size": number or null,
    "unit": "sq.yd or sq.ft or marla or kanal or acre or empty",
    "budgetMin": number or null,
    "budgetMax": number or null,
    "facing": "North or South or East or West or North-East or North-West or South-East or South-West or Corner or empty",
    "contact": "name and/or phone if mentioned",
    "notes": "any extra details like roof rights, floor number, registry status, road width"
  }
]
 
Money rules: 1 cr = 10000000, 1 lac/lakh = 100000. Single price = budgetMax.
gaj = sq.yd always. SF/sqyrd/sq.yd all mean sq.yd.
If header says "Available For Sale" all items are sell type.
If message has a brand name (Godrej, BPTP etc) put it in notes.
Always return an array even for a single listing.`;
 
async function parseWithClaude(text) {
  console.log('[Claude] Parsing:', text.slice(0, 100));
  const result = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    }
  );
  if (!result.content) throw new Error('No content from Claude: ' + JSON.stringify(result));
  const txt = result.content.map(b => b.text || '').join('');
  const clean = txt.replace(/```json|```/g, '').trim();
  console.log('[Claude] Raw output:', clean.slice(0, 300));
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed) ? parsed : [parsed];
}
 
// ── Twilio send ───────────────────────────────────────────────────────
async function sendWA(to, body) {
  console.log('[WA] Sending to:', to, '| Message:', body.slice(0, 80));
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.log('[WA] Missing Twilio creds — would have sent:', body);
    return;
  }
  const form = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: body }).toString();
  const auth = 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
  await httpsPostForm(
    'api.twilio.com',
    `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    auth, form
  );
}
 
// ── Matchmaking ───────────────────────────────────────────────────────
function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
 
function fmtINR(n) {
  if (!n) return '';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(1).replace(/\.?0+$/, '') + ' L';
  return '₹' + n;
}
 
function fmtBudget(min, max) {
  if (min && max) return fmtINR(min) + '–' + fmtINR(max);
  if (max) return 'up to ' + fmtINR(max);
  if (min) return fmtINR(min) + '+';
  return '';
}
 
function summarize(i) {
  return [
    i.type.toUpperCase(),
    i.category, i.bhk,
    i.locality, i.subLocality,
    i.size ? i.size + ' ' + i.unit : '',
    i.facing ? i.facing + ' facing' : '',
    fmtBudget(i.budgetMin, i.budgetMax),
    i.contact, i.notes
  ].filter(Boolean).join(' | ');
}
 
function isMatch(buyer, seller) {
  // Locality must overlap
  const lb = norm(buyer.locality), ls = norm(seller.locality);
  if (!lb || !ls) return false;
  if (lb !== ls && !lb.includes(ls) && !ls.includes(lb)) return false;
  // Category must align if both specified
  if (buyer.category && seller.category && buyer.category !== seller.category) return false;
  // Budget: buyer max must cover seller ask (5% grace)
  const bMax = buyer.budgetMax || buyer.budgetMin;
  const sAsk = seller.budgetMax || seller.budgetMin;
  if (!bMax || !sAsk) return false;
  return bMax >= sAsk * 0.95;
}
 
function findMatches(newItem, allItems) {
  const opposite = allItems.filter(d => {
    if (d.id === newItem.id) return false;
    if (newItem.type === 'buy')  return d.type === 'sell';
    if (newItem.type === 'sell') return d.type === 'buy';
    return d.type === 'rent';
  });
  const hits = [];
  for (const cand of opposite) {
    const buyer  = newItem.type === 'sell' ? cand : newItem;
    const seller = newItem.type === 'sell' ? newItem : cand;
    if (isMatch(buyer, seller)) hits.push({ buyer, seller });
  }
  return hits;
}
 
// ── Express ───────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
 
app.get('/', (_, res) => res.send('PlotMatch server is live ✅'));
 
app.get('/requirements', (_, res) => {
  res.json(readDB().requirements);
});
 
app.post('/webhook', async (req, res) => {
  // ACK Twilio immediately
  res.status(200).set('Content-Type', 'text/xml').send('<Response></Response>');
 
  const msgBody = (req.body.Body || '').trim();
  const from    = req.body.From || '';
  const name    = req.body.ProfileName || '';
 
  console.log(`[Webhook] From: ${from} (${name}) | Body: ${msgBody.slice(0, 120)}`);
 
  if (!msgBody) return;
 
  try {
    const listings = await parseWithClaude(msgBody);
    console.log(`[Webhook] Parsed ${listings.length} listing(s)`);
 
    const data = readDB();
    const matchAlerts = [];
 
    for (const listing of listings) {
      const item = {
        id: uid(),
        type: listing.type || 'sell',
        category: listing.category || '',
        bhk: listing.bhk || '',
        locality: listing.locality || '',
        subLocality: listing.subLocality || '',
        size: listing.size || null,
        unit: listing.unit || '',
        budgetMin: listing.budgetMin || null,
        budgetMax: listing.budgetMax || null,
        facing: listing.facing || '',
        contact: listing.contact || name || from,
        notes: listing.notes || '',
        rawText: msgBody,
        source: from,
        createdAt: Date.now()
      };
 
      const hits = findMatches(item, data.requirements);
      data.requirements.unshift(item);
 
      if (hits.length > 0) {
        for (const hit of hits) {
          matchAlerts.push(
            `🎯 MUTUAL MATCH!\n` +
            `BUYER: ${hit.buyer.contact || 'Unknown'}\n${summarize(hit.buyer)}\n\n` +
            `SELLER: ${hit.seller.contact || 'Unknown'}\n${summarize(hit.seller)}\n\n` +
            `✅ Locality & budget align — connect them now!`
          );
        }
      }
    }
 
    writeDB(data);
 
    if (matchAlerts.length > 0) {
      await sendWA(from, matchAlerts.join('\n\n───────────\n\n'));
    } else {
      const saved = listings.map(l =>
        `• ${l.type?.toUpperCase()} ${l.category || ''} ${l.bhk || ''} ${l.locality || ''} ${l.size ? l.size + ' ' + l.unit : ''} ${fmtBudget(l.budgetMin, l.budgetMax)}`
      ).join('\n');
      await sendWA(from,
        `✅ Saved ${listings.length} listing(s):\n${saved}\n\nNo match yet — you'll be notified instantly when one comes in.`
      );
    }
 
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    await sendWA(from, `⚠️ Error processing your message. Check server logs.\n\nError: ${err.message.slice(0, 100)}`);
  }
});
 
app.listen(PORT, () => {
  console.log(`\n✅ PlotMatch server running on port ${PORT}`);
  console.log(`   ANTHROPIC_API_KEY : ${ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_AUTH_TOKEN : ${TWILIO_AUTH_TOKEN ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_WA_FROM    : ${TWILIO_WHATSAPP_FROM || 'MISSING ✗'}\n`);
});
