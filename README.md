[server.js](https://github.com/user-attachments/files/29506175/server.js)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const twilio = require('twilio');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// ---------- tiny JSON database ----------
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ requirements: [] }).write();

function uid(){ return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

// ---------- Claude parsing ----------
const SYSTEM_PROMPT = `You are a real-estate data extraction agent for the Faridabad, Haryana (NCR, India) market. Extract a SINGLE structured requirement from a raw WhatsApp message written in Hindi/English/Hinglish. You understand local real-estate vocabulary: plot, floor (independent floor), flat, builder floor, kothi, file (an under-construction/unregistered plot allotment paper), BHK, sq.yd / gaj / gajj (1 gaj = 1 sq.yd), marla (~272.25 sq.ft in Haryana), kanal (20 marla), biswa, acre, sq.ft, corner plot, park-facing, road-facing, north/south/east/west facing and combinations (north-east etc), registry, conversion (CLU), HUDA/HSVP sector numbers, cr (crore), lac/lakh as currency shorthand.

Respond ONLY with raw JSON (no markdown fences, no prose) matching this exact schema:
{"type":"buy|sell|rent","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"string or empty","locality":"string","size":number or null,"unit":"sq.yd|gaj|marla|kanal|sq.ft|acre|biswa or empty","budgetMin":number or null,"budgetMax":number or null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner or empty","contact":"string or empty","notes":"string, any extra detail like file/registry/road width/condition"}

Rules: convert crore/lakh/lac into full rupee numbers (1.5 cr = 15000000, 50 lac = 5000000). If only one budget figure given, set it as budgetMax. gaj and sq.yd are the same unit, normalize to "sq.yd". If type is unclear, infer "buy" when the message expresses wanting/looking for something ("chahiye", "looking for", "required"), and "sell" when offering/listing something ("available", "for sale", "becharu hai").`;

async function parseWithClaude(text){
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }]
    })
  });
  const data = await resp.json();
  if (!data.content) throw new Error("Claude API error: " + JSON.stringify(data));
  const textOut = data.content.map(b => b.text || '').join('');
  const clean = textOut.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ---------- matchmaking engine (same logic as the dashboard) ----------
function normLoc(s){ return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function fmtINR(n){
  if (n === null || n === undefined) return null;
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(n % 10000000 === 0 ? 0 : 2) + ' Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(n % 100000 === 0 ? 0 : 1) + ' L';
  return '₹' + n.toLocaleString('en-IN');
}
function fmtBudget(min, max){
  if (min && max) return fmtINR(min) + ' – ' + fmtINR(max);
  if (max) return 'up to ' + fmtINR(max);
  if (min) return fmtINR(min) + '+';
  return 'budget n/a';
}
function summarize(item){
  const bits = [item.category || 'Property'];
  if (item.bhk) bits.push(item.bhk);
  if (item.locality) bits.push('in ' + item.locality);
  if (item.size) bits.push(item.size + ' ' + (item.unit || ''));
  if (item.facing) bits.push(item.facing + ' facing');
  bits.push(fmtBudget(item.budgetMin, item.budgetMax));
  return bits.join(', ');
}
function shortLabel(item){
  return (item.contact || item.id) + ' — ' + (item.category || 'Property') +
    (item.bhk ? (' ' + item.bhk) : '') + ' in ' + (item.locality || 'locality n/a');
}
function strictCompatible(buyer, seller){
  const lb = normLoc(buyer.locality), ls = normLoc(seller.locality);
  const locationOk = lb && ls && (lb === ls || lb.includes(ls) || ls.includes(lb));
  const categoryOk = !buyer.category || !seller.category || buyer.category === seller.category;
  const buyerMax = buyer.budgetMax || buyer.budgetMin;
  const sellerAsk = seller.budgetMax || seller.budgetMin;
  const budgetOk = (!buyerMax || !sellerAsk) ? false : buyerMax >= sellerAsk * 0.95;
  return locationOk && categoryOk && budgetOk;
}
function runMatchEngine(newItem, allItems){
  const opposite = newItem.type === 'buy' ? allItems.filter(d => d.type === 'sell' && d.id !== newItem.id)
                  : newItem.type === 'sell' ? allItems.filter(d => d.type === 'buy' && d.id !== newItem.id)
                  : allItems.filter(d => d.type === 'rent' && d.id !== newItem.id);
  for (const cand of opposite) {
    const buyer = newItem.type === 'sell' ? cand : newItem;
    const seller = newItem.type === 'sell' ? newItem : cand;
    if (strictCompatible(buyer, seller)) return { buyer, seller };
  }
  return null;
}

// ---------- Twilio reply helper ----------
async function sendWhatsApp(to, body){
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log('[would send WhatsApp to', to, ']', body);
    return;
  }
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to,
    body
  });
}

// ---------- app ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('PlotMatch webhook server is running. POST WhatsApp messages to /webhook.');
});

app.get('/requirements', (req, res) => {
  res.json(db.get('requirements').value());
});

app.post('/webhook', async (req, res) => {
  const body = req.body.Body || '';
  const from = req.body.From || ''; // e.g. "whatsapp:+9198xxxxxxx0"
  const profileName = req.body.ProfileName || '';

  // Always acknowledge Twilio immediately to avoid timeout/retries
  res.status(200).send('<Response></Response>');

  if (!body.trim()) return;

  try {
    const parsed = await parseWithClaude(body);
    const item = Object.assign({
      id: uid(),
      type: 'buy', category: '', bhk: '', locality: '', size: null, unit: '',
      budgetMin: null, budgetMax: null, facing: '', contact: profileName || from, notes: '',
      rawText: body, source: from, createdAt: Date.now()
    }, parsed, { contact: parsed.contact || profileName || from, rawText: body, source: from });

    const all = db.get('requirements').value();
    const hit = runMatchEngine(item, all);

    db.get('requirements').push(item).write();

    if (hit) {
      const alert =
        `MUTUAL MATCH IDENTIFIED!\n\n` +
        `Buyer: ${shortLabel(hit.buyer)} — ${summarize(hit.buyer)}\n` +
        `Seller: ${shortLabel(hit.seller)} — ${summarize(hit.seller)}\n\n` +
        `Locality matches and budget covers the asking price. Time to connect them.`;
      await sendWhatsApp(from, alert);
    } else {
      await sendWhatsApp(from, `Saved: ${summarize(item)}. No match yet — you'll be notified the moment a compatible entry comes in.`);
    }
  } catch (err) {
    console.error('Error processing message:', err);
    await sendWhatsApp(from, "Couldn't parse that message automatically. Please check the wording or add it manually in the dashboard.");
  }
});

app.listen(PORT, () => console.log(`PlotMatch server listening on port ${PORT}`));
