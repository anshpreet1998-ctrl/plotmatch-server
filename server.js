require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
 
const PORT = process.env.PORT || 10000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHAPI_TOKEN = process.env.WHAPI_TOKEN; // whapi.cloud token
 
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
 
TYPE CLASSIFICATION — classify EACH item individually:
"buy"       = wants to PURCHASE (chahiye, required, looking for, lena hai, buyer hai, confirm party, urgent required)
"sell"      = wants to SELL (bechna hai, for sale, available, confirmed inventory, rate/demand/price quoted, plot listed with size+block)
"rent_want" = wants to RENT a place (required for rent, rent chahiye, budget X/month)
"rent_have" = has property TO RENT OUT (available for rent, rent pe dena hai)
 
MIXED INTENT: A single message can have BOTH sell and buy items. e.g. "Confirmed plots: S blk 245sqyd ... Urgent required plot in gulmohar" — the first items are SELL, last one is BUY. Classify each independently.
 
CONTEXT SHIFT: If someone changed intent (pehle rent chahiye tha ab bech raha hai), extract CURRENT intent only. Note the shift.
 
PRICE FORMATS:
- "@69000" after plot size = rate PER sq.yd. budgetMax = size x rate (200 gaj @69000 = 13800000)
- "2 lakh per sq yard" = rate per sq.yd, multiply by size
- "1.60/Sq.yd" = 1.60 lakh per sq.yd, multiply by size
- "Demand 63L" = total 63 lakh = 6300000
- Rent "20-30" = monthly rent budgetMin=20000 budgetMax=30000
- "3 Crore 70 Lakh" or "3.70 Cr" = 37000000
 
EXTRACTION RULES:
- CRITICAL: Extract EACH property as its own separate JSON object — NEVER merge multiple into one
- A new listing starts when you see a new: sector number, society name, plot size, or price
- NUMBERED LISTS (1. 2. 3.) = each number is a SEPARATE listing
- NUMBERED EMOJI BOXES (1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ etc) = each is a SEPARATE listing. 📍 pin emoji also = separate listing — very common in Indian broker groups. Numbers may reset (back to 1️⃣) for each new section — still extract each as separate
- EMOJI BULLETS (👉 ✅ 🔹 ➡️ ⚡ 💥 🏡 ☞ ✔️ 🙏 •) = each emoji line is a SEPARATE listing
- BULLETED LISTS (• - * -) = each bullet is a SEPARATE listing
- LINE BREAKS between properties = each block is a SEPARATE listing
- SECTION HEADERS: A plain/bold line with just a society or location name ("Bptp plots", "Huda sector 77", "Amolik Asterwood 98", "Bptp Villa") with no size/price = a HEADER that applies to all items listed below it until the next header. Use it as locality for those sub-items
- MIXED BUY+SELL: classify each item individually — "required/chahiye" = buy even in a sell-heavy message
- SAME SELLER multiple properties = separate listings, same contact on each
- Contact/agent name+phone at BOTTOM applies to ALL listings above it
- BPTP PLOT CODES: "PA110"=P-A Block plot 110, "W11-24"=W Block, "M5-15"=M Block, "F3-18"=F Block — block letter goes in subLocality
- "Plot no 251" or "687 size 162" = plot number, put in notes
- "Pride" after BPTP plot = BPTP Pride society, add to notes
- SCO = Shop Cum Office → category=Shop
- gaj=sq.yd. sqyd=sq.yd. sy/SY=sq.yd. SF/Sqft=sq.ft. Marla=272sq.ft. Kanal=20 marla.
- "2 .10 Cr" with space = 2.10 Cr = 21000000. "@1.35"=13500000. "@1.60/yd"=1.60L×size
- Size range "1400-1450 feet" = average = 1425 sq.ft
- "Confirm Inventory"/"Available For Sale"/"FOR SALE"/"CONFIRM BPTP PLOTS" = header, all below are type=sell
- "Properties Available for Rent"/"Available for Rent"/"For Rent" = header, all below are type=rent_have
- "Rent: ₹35,000/month" or "Rent: ₹28,000/Month" = monthly rent budgetMax=35000 or 28000
- "Rent - 32000" or "Rent- 32000" = monthly rent budgetMax=32000
- "3+1 BHK" or "3+1" = bhk="3+1 BHK"
- "Multiple options available" / "For confirmed requirements" = NOT a listing, skip
- Notes: Stilt+4, NOC, Registry, Joda/Pair, furnishing, map approved, corner, park facing, road width, roof, terrace, basement, pool, semi commercial, naksha passed
 
SECTION HEADER EMOJIS: 🏛️ and 🛣️ on the SAME line as society name = section header
- "🏛️*Discovery park*" = Discovery Park is the society/locality for all ➡️ items below
- "🛣️*Adore Exclusive Sec -86*" = Adore Exclusive, Sector 86 is locality
- Sub-items under the header use ➡️ 👉 💥 emojis = each is a SEPARATE listing
 
BHK FORMAT WITH EXTRA ROOMS:
- "2+2" = 2BHK + 2 extra rooms → bhk="2+2 BHK"
- "3+2" = 3BHK + 2 extra rooms → bhk="3+2 BHK"
- "3+3" = 3BHK + 3 extra rooms → bhk="3+3 BHK"
- "3+1" = 3BHK + 1 servant room → bhk="3+1 BHK"
- "2+1" = 2BHK + 1 servant room → bhk="2+1 BHK"
 
FURNISHING SHORTHAND:
- "Semi" = Semi-furnished → notes="Semi-furnished"
- "Raw" = Unfurnished/bare → notes="Raw/Unfurnished"
- "GF" = Ground Floor → notes="Ground Floor"
- "Lower" = Lower ground floor → notes="Lower ground floor"
- "4th +roof" = 4th floor with roof rights → notes="4th floor with roof rights"
- "Double Storey" = G+1 construction → notes="Double Storey"
- "Single Storey" = Ground floor only → notes="Single Storey"
 
BUILDER FLOOR SHORTHAND:
- "B.p.home" or "BP home" or "B.P.Home" = Builder's property / Builder Floor → category="Floor"
 
SECTOR FORMAT WITH DASH:
- "Sec -76" or "Sec-76" = Sector 76 (dash is just formatting, not subtraction)
- "Sec -86" = Sector 86
 
PRICE FORMAT:
- "@ .1.45cr" = typo for 1.45cr = 14500000 (extra dot before number, ignore it)
- "@ 70Lac" or "@ 68Lac" = 70 lakh = 7000000, 68 lakh = 6800000
 
CONTACT: "Vishwas properties / Jatin Sharma / 9319000940" = all three lines = one contact entry
 
LEFT-POINTING EMOJIS: 👈 👈🏻 👈🏼 👈🏽 👈🏾 👈🏿 (pointing left, with any skin tone) = same as 👉, treat as bullet or emphasis marker
SKIN TONE EMOJI VARIANTS: Any emoji with 🏻🏼🏽🏾🏿 modifier = same as base emoji
"Party confirm" / "Confirm party" = the client is verified/serious — NOT a separate listing, add to notes of previous listing as "Confirmed party"
"Only WhatsApp call SMS" = contact instruction, not a listing — add to contact notes
"District A B Block" = BPTP District, A Block and B Block → locality="Sector 81 Faridabad", subLocality="District A-B Block"
"SGA" at end of message = sender's initials, not a listing — skip
 
BPTP SPECIFIC PRICE FORMAT:
- "@450Reg" / "@355Reg" / "@610Reg" = TOTAL price in LAKHS → budgetMax = number × 100000
- Example: "@450Reg" = 450 lakh = ₹4.5 Cr = 45000000
- Example: "@610Reg" = 610 lakh = ₹6.1 Cr = 61000000
- "@205000 per sqyrd" or "@205000 per sq.yd" = RATE per sq.yd → budgetMax = size × 205000
- "Reg" suffix ALWAYS = Registry clear → add "Registry" to notes
- "naksha passed" = map/building plan approved → add to notes
- "east+park" or "east + park" = facing="East", notes="Park facing"
 
BPTP BLOCK-SIZE CODE FORMAT:
- "D-250sy" = Block D, 250 sq.yd → subLocality="D Block", size=250, unit="sq.yd"
- "E-300sy" = Block E, 300 sq.yd → subLocality="E Block"
- "K-300sy" = Block K → subLocality="K Block"
- "Pc-229sy" = PC Block → subLocality="PC Block"
- "Pe-210sy" = PE Block → subLocality="PE Block"
- "T-264sy" = Block T → subLocality="T Block"
- Letter(s) before hyphen = block name, number after hyphen + sy = size in sq.yd
- "MORE OPTIONS IN ALL BLOCKS" / "PLS CALL" = NOT a listing, skip these lines entirely
 
RETURN ONLY raw JSON array, zero markdown:
[{"type":"buy|sell|rent_want|rent_have","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|Park-Facing","contact":"","notes":""}]
Always return array. Extract full name AND phone into contact field.`;
 
async function parseWithClaude(text) {
  const result = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-6', max_tokens: 4000, system: PARSE_PROMPT, messages: [{ role: 'user', content: text }] }
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
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>PlotMatch Server</title>
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F5EFE4;}
.box{text-align:center;background:#fff;border-radius:12px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,.1);}
h1{color:#1A6B3C;font-size:28px;margin-bottom:8px;}p{color:#7A7164;font-size:14px;}
.badge{background:#EAF4ED;color:#1A6B3C;border:1px solid #1A6B3C;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700;display:inline-block;margin-bottom:20px;}
.stat{display:inline-block;margin:0 12px;text-align:center;}
.stat-n{font-size:24px;font-weight:800;color:#B5562F;}
.stat-l{font-size:11px;color:#aaa;text-transform:uppercase;}</style>
</head>
<body><div class="box">
<div class="badge">✅ ONLINE</div>
<h1>PlotMatch Server</h1>
<p>Faridabad Real Estate Matchmaking Engine</p>
<div style="margin-top:20px;">
  <div class="stat"><div class="stat-n">${inbox.length}</div><div class="stat-l">Inbox</div></div>
  <div class="stat"><div class="stat-n">${processedCount}</div><div class="stat-l">Processed</div></div>
</div>
<p style="margin-top:20px;font-size:12px;color:#ccc;">Webhook: POST /webhook &nbsp;·&nbsp; Inbox: GET /inbox</p>
</div></body></html>`));
 
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
 
// ── Whapi.cloud send ──────────────────────────────────────────────────
async function sendWhapiMessage(to, body) {
  if (!WHAPI_TOKEN) { console.log('[Whapi skipped - no token]'); return; }
  // to format: "919811234567" (no + or @)
  const phone = to.replace(/[^0-9]/g, '');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ to: phone, body });
    const req = https.request({
      hostname: 'gate.whapi.cloud',
      path: '/messages/text',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WHAPI_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let r = ''; res.on('data', c => r += c);
      res.on('end', () => { console.log('[Whapi send]', r.slice(0,120)); resolve(r); });
    });
    req.on('error', e => { console.error('[Whapi error]', e.message); reject(e); });
    req.write(payload); req.end();
  });
}
 
function formatINR(n) {
  if (!n) return '';
  if (n >= 10000000) return (n/10000000).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 100000) return (n/100000).toFixed(1).replace(/\.?0+$/, '') + ' L';
  return n.toString();
}
 
// ── WHITELISTED GROUPS ─────────────────────────────────────────────────
const ALLOWED_GROUPS = [
  'Aagman Infra FBD Inventory',
  'Bptp Properties Faridabad 🏠',
  'All Properties Neharpar',
  'ᴏɴʟʏ ꜰᴏʀ ʀᴇɴᴛ ꜰᴀʀɪᴅᴀʙᴀᴅ',
  'Chikki Realtors Dealers Group',
  'Faridabad Associates 2',
  '🇮🇳 Only Renting In Fbd',
  'AMAN PROPERTY',
  'SEC 81 FBD BROKERS 📍'
];
 
// Groups that are rent-focused (helps AI classify correctly)
const RENT_GROUPS = [
  'ᴏɴʟʏ ꜰᴏʀ ʀᴇɴᴛ ꜰᴀʀɪᴅᴀʙᴀᴅ',
  '🇮🇳 Only Renting In Fbd'
];
 
function isAllowedGroup(chatName) {
  if (!chatName) return false;
  // Exact match
  if (ALLOWED_GROUPS.includes(chatName)) return true;
  // Strip ALL non-alphanumeric (emojis, spaces, punctuation) and compare
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normChat = norm(chatName);
  if (ALLOWED_GROUPS.some(g => norm(g) === normChat)) return true;
  // Partial match — if chat name CONTAINS any allowed group keyword
  const keywords = ['aagman','bptp','neharpar','rent faridabad','chikki','faridabad associates','renting in fbd','aman property','sec 81','fbd brokers','only rent','only renting'];
  return keywords.some(k => chatName.toLowerCase().includes(k));
}
 
// ── Whapi.cloud webhook ────────────────────────────────────────────────
app.post('/whapi-webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });
 
  const messages = req.body.messages || [];
  if (!messages.length) return;
 
  for (const msg of messages) {
    if (msg.type !== 'text') continue;
    if (msg.from_me) continue;
 
    const msgBody  = (msg.text && msg.text.body) ? msg.text.body.trim() : '';
    const from     = msg.from || '';
    const name     = msg.from_name || '';
    const chatId   = msg.chat_id || from;
    const chatName = msg.chat_name || msg.chat?.name || '';
    const isGroup  = chatId.includes('@g.us');
 
    if (!msgBody) continue;
 
    // ── WHITELIST CHECK ────────────────────────────────────────────────
    console.log(`[Whapi] Received | Group: "${chatName}" | isGroup: ${isGroup} | Allowed: ${isAllowedGroup(chatName)}`);
 
    if (isGroup && !isAllowedGroup(chatName)) {
      console.log(`[Whapi] ⛔ SKIPPED group not in whitelist: "${chatName}"`);
      continue;
    }
 
    // Skip non-group messages (personal chats)
    if (!isGroup) {
      console.log(`[Whapi] ⛔ SKIPPED direct msg from: ${name}`);
      continue;
    }
 
    console.log(`[Whapi] ✅ ALLOWED group: "${chatName}" | ${name} | ${msgBody.slice(0,80)}`);
 
    // Check if this is a rent-focused group — hint to AI
    const isRentGroup = RENT_GROUPS.some(g => g === chatName || chatName.toLowerCase().includes('rent'));
    const rentHint = isRentGroup ? '\n\nNOTE: This message is from a RENT group. If intent is unclear, classify as rent_want or rent_have.' : '';
 
    try {
      const listings = await parseWithClaude(msgBody + rentHint);
      if (!listings || !listings.length) continue;
      console.log(`[Whapi] Parsed ${listings.length} listing(s) from "${chatName}"`);
 
      inbox.push({
        id: 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        listings,
        rawText: msgBody,
        from: from.replace('@s.whatsapp.net','').replace('@g.us',''),
        name: name,
        source: 'whatsapp-group',
        chatName,
        receivedAt: Date.now()
      });
      processedCount++;
 
    } catch(err) {
      console.error('[Whapi parse error]', err.message);
    }
  }
});
 
app.listen(PORT, () => {
  console.log(`\n✅ PlotMatch server on port ${PORT}`);
  console.log(`   ANTHROPIC_API_KEY : ${ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_AUTH_TOKEN : ${TWILIO_AUTH_TOKEN ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_WA_FROM    : ${TWILIO_WHATSAPP_FROM || 'MISSING ✗'}\n`);
});
 
