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
let groupStats = {}; // tracks messages per group
let skippedCount = 0;

// ── KEYWORD PRE-FILTER (skip Claude API if no property keywords found)
const PROPERTY_KEYWORDS = [
  'plot','gaj','sqyd','sq.yd','sqft','sq.ft','marla','kanal',
  'bhk','floor','flat','kothi','villa','duplex',
  'sale','sell','bechna','available','required','chahiye','rent',
  'sector','sec','block','society','faridabad','neharpar','bptp',
  'cr','lac','lakh','lacs','budget','demand','price','rate',
  'noc','registry','noksha','naksha','furnished','semi','raw',
  'bedroom','room','property','residential','commercial','office','shop'
];

function hasPropertyKeywords(text) {
  const lower = text.toLowerCase();
  return PROPERTY_KEYWORDS.some(kw => lower.includes(kw));
}

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
const PARSE_PROMPT = `Real-estate message parser for Faridabad/NCR, India. Extract ALL listings from WhatsApp messages (Hindi/English/Hinglish).

TYPES: buy=wants to purchase, sell=has property for sale, rent_want=wants to rent, rent_have=property available for rent

SEPARATORS — each is a separate listing:
- Emoji bullets: 👉 📍 ✅ 🔹 ➡️ 💥 🏡 ☞ ✔️ 🙏 👈 👈🏻 👈🏼
- Numbered emoji: 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣
- Section headers: 🏛️ or 🛣️ on same line as society name = locality for all sub-items below
- Numbers: 1. 2. 3. or line breaks between properties
- WhatsApp bold *text* = society/header name

PRICES:
- @450Reg = 450 lakh total = 45000000. @610Reg = 61000000
- @1.35 = 13500000. @2.55Cr = 25500000. 2.10Cr = 21000000
- @205000/sqyrd = rate×size. @1.60/yd = 160000×size
- 2.25cr-2.35cr = budgetMin+Max. Rent 20-30 = 20000-30000/month
- Reg suffix = Registry → notes. @.1.45cr typo = 1.45cr

UNITS: gaj=sq.yd. sqyd=sq.yd. sy=sq.yd. SF=sq.ft. Marla=272sq.ft. Kanal=20 marla

VOCAB: 2+2/3+2/3+3 BHK = BHK+extra rooms. Raw=unfurnished. Semi=semi-furnished. GF=ground floor. B.p.home/BP home=Builder Floor. SCO=Shop Cum Office. Sec-76=Sector 76. Naksha passed=map approved. east+park=East+Park facing. Double/Single Storey→notes. Villa=Plot/House. Stilt+4/Map approved/NOC/Registry/Joda→notes

BLOCK CODES: D-250sy=Block D 250sqyd. PA110=P-A Block. W11-24=W Block. Pc=PC Block
BPTP: Section header (Bptp plots/Huda sector 77/Amolik etc) applies to all items below until next header

EMOJI FIELDS (within one listing, not separators):
📍=location/new listing. 📐=size. 🏢🏠=floor. 🛋️=furnishing. 💰=price. 📞=contact

SKIP: "MORE OPTIONS IN ALL BLOCKS", "PLS CALL", "Party confirm"→notes, "Multiple options available", "SGA", "Only WhatsApp call SMS", "Jai Guru Ji"

MIXED: Same message can have buy AND sell items. Classify each individually.
SHIFT: If intent changed (rent→sell), extract current only, note shift.
FOR SALE/CONFIRM/Available = all below are sell. FOR RENT/Available for Rent = all below are rent_have.

RETURN only raw JSON array, no markdown:
[{"type":"buy|sell|rent_want|rent_have","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|Park-Facing","contact":"","notes":""}]
Always array. Name+phone in contact.`;

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

// iOS App route
app.get('/app', (_, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<meta name="apple-mobile-web-app-title" content="PlotMatch">\n<meta name="theme-color" content="#1A1612">\n<title>PlotMatch</title>\n\n<!-- iOS Icons -->\n<link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 180 180\'><rect width=\'180\' height=\'180\' rx=\'40\' fill=\'%231A1612\'/><text x=\'90\' y=\'115\' font-size=\'80\' text-anchor=\'middle\' fill=\'%23B5562F\' font-family=\'Arial Black\'>PM</text></svg>">\n\n<style>\n/* ── iOS SAFE AREA + RESET ── */\n:root {\n  --ink:#1A1612; --bg:#F5EFE4; --card:#FFFFFF; --line:#E0D8CC;\n  --buy:#C0392B; --sell:#1A6B3C; --rw:#7D5A00; --rh:#1A5276;\n  --accent:#B5562F; --muted:#7A7164; --gold:#C9A227;\n  --tab-h:60px; --nav-h:52px;\n  --safe-top: env(safe-area-inset-top);\n  --safe-bottom: env(safe-area-inset-bottom);\n}\n* { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }\nhtml, body { height:100%; overflow:hidden; background:var(--ink); }\nbody {\n  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;\n  font-size:15px; color:var(--ink);\n  padding-top: var(--safe-top);\n  padding-bottom: var(--safe-bottom);\n}\n\n/* ── NAVBAR ── */\n.navbar {\n  background:var(--ink); color:#fff;\n  height:var(--nav-h); display:flex; align-items:center;\n  justify-content:space-between; padding:0 16px;\n  position:fixed; top:var(--safe-top); left:0; right:0; z-index:100;\n}\n.nav-brand { display:flex; align-items:center; gap:8px; }\n.nav-mark { background:var(--accent); font-weight:900; font-size:12px;\n  letter-spacing:.1em; padding:4px 7px; border-radius:6px; }\n.nav-title { font-size:18px; font-weight:700; letter-spacing:-.02em; }\n.nav-right { display:flex; align-items:center; gap:8px; }\n.dot { width:7px; height:7px; border-radius:50%; background:#555; flex-shrink:0; }\n.dot.ok { background:#4caf50; box-shadow:0 0 6px #4caf5066; }\n.dot.err { background:#f44; }\n#syncLbl { font-size:11px; color:#aaa; }\n\n/* ── SCREENS ── */\n.screen-wrap {\n  position:fixed;\n  top:calc(var(--safe-top) + var(--nav-h));\n  bottom:calc(var(--safe-bottom) + var(--tab-h));\n  left:0; right:0;\n  overflow:hidden;\n}\n.screen { display:none; height:100%; overflow-y:auto; -webkit-overflow-scrolling:touch; background:var(--bg); }\n.screen.active { display:block; }\n\n/* ── BOTTOM TAB BAR ── */\n.tabbar {\n  position:fixed; bottom:0; left:0; right:0;\n  height:calc(var(--tab-h) + var(--safe-bottom));\n  background:var(--card); border-top:1px solid var(--line);\n  display:flex; align-items:flex-start; padding-top:8px;\n  padding-bottom:var(--safe-bottom);\n  z-index:100;\n}\n.tab-item {\n  flex:1; display:flex; flex-direction:column; align-items:center;\n  gap:3px; background:none; border:none; cursor:pointer;\n  color:var(--muted); font-size:10px; font-weight:600;\n  letter-spacing:.02em; padding:0;\n}\n.tab-item.active { color:var(--accent); }\n.tab-icon { font-size:22px; line-height:1; }\n.tab-badge {\n  position:absolute; top:-2px; right:calc(50% - 18px);\n  background:var(--buy); color:#fff; font-size:9px; font-weight:800;\n  min-width:16px; height:16px; border-radius:8px; padding:0 4px;\n  display:flex; align-items:center; justify-content:center;\n}\n\n/* ── CARDS & FORMS ── */\n.page-pad { padding:14px; }\n.section-title { font-size:11px; font-weight:700; letter-spacing:.1em;\n  text-transform:uppercase; color:var(--accent); margin-bottom:10px; }\n.card { background:var(--card); border-radius:14px; padding:16px;\n  margin-bottom:12px; box-shadow:0 2px 10px rgba(0,0,0,.06); }\n.field { margin-bottom:12px; }\n.field label { display:block; font-size:11px; color:var(--muted); margin-bottom:5px;\n  text-transform:uppercase; letter-spacing:.05em; font-weight:600; }\n.field input, .field select, .field textarea {\n  width:100%; border:1.5px solid var(--line); border-radius:10px;\n  padding:11px 13px; font-size:15px; background:#FCFAF5;\n  color:var(--ink); font-family:inherit; -webkit-appearance:none;\n  appearance:none;\n}\n.field textarea { min-height:100px; resize:none; line-height:1.5; }\n.field input:focus, .field select:focus, .field textarea:focus {\n  outline:none; border-color:var(--accent); background:#fff;\n}\n.two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }\n.three { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }\n\n/* ── BUTTONS ── */\n.btn { font-family:inherit; font-weight:700; font-size:15px; border:none;\n  border-radius:12px; padding:14px; cursor:pointer; width:100%;\n  letter-spacing:.01em; transition:opacity .15s; }\n.btn:active { opacity:.75; }\n.btn-primary { background:var(--accent); color:#fff; }\n.btn-ghost { background:var(--line); color:var(--ink); }\n\n/* ── STATS ROW ── */\n.stats-row { display:flex; gap:8px; padding:14px 14px 0; overflow-x:auto; }\n.stats-row::-webkit-scrollbar { display:none; }\n.stat-chip { background:var(--card); border-radius:12px; padding:10px 14px;\n  text-align:center; min-width:72px; flex-shrink:0;\n  box-shadow:0 2px 8px rgba(0,0,0,.06); }\n.stat-n { font-size:22px; font-weight:800; line-height:1; }\n.stat-l { font-size:10px; color:var(--muted); margin-top:2px;\n  text-transform:uppercase; letter-spacing:.05em; }\n\n/* ── SEARCH BAR ── */\n.search-wrap { padding:10px 14px; }\n.search-bar { display:flex; gap:8px; align-items:center; }\n.search-input { flex:1; background:var(--card); border:1.5px solid var(--line);\n  border-radius:12px; padding:10px 14px; font-size:15px; font-family:inherit;\n  color:var(--ink); }\n.search-input:focus { outline:none; border-color:var(--accent); }\n.filter-btn { background:var(--card); border:1.5px solid var(--line);\n  border-radius:12px; padding:10px 12px; font-size:14px; white-space:nowrap;\n  cursor:pointer; -webkit-appearance:none; font-family:inherit; color:var(--ink); }\n\n/* ── REQ CARDS ── */\n.req-list { padding:0 14px 14px; }\n.req-card { background:var(--card); border-radius:14px; padding:14px;\n  margin-bottom:10px; box-shadow:0 2px 10px rgba(0,0,0,.06);\n  border-left:4px solid transparent; }\n.req-card.buy { border-left-color:var(--buy); }\n.req-card.sell { border-left-color:var(--sell); }\n.req-card.rent_want { border-left-color:var(--rw); }\n.req-card.rent_have { border-left-color:var(--rh); }\n.req-card.is-dup { border-left-color:var(--gold); }\n.req-top { display:flex; justify-content:space-between; align-items:flex-start; }\n.req-info { flex:1; }\n.tag { font-weight:800; font-size:10px; letter-spacing:.08em; text-transform:uppercase;\n  padding:3px 9px; border-radius:20px; color:#fff; display:inline-block; margin-bottom:6px; }\n.tag.buy { background:var(--buy); }\n.tag.sell { background:var(--sell); }\n.tag.rent_want { background:var(--rw); }\n.tag.rent_have { background:var(--rh); }\n.wa-tag { background:#E8F4FB; color:var(--rh); font-size:9px; font-weight:700;\n  padding:2px 7px; border-radius:20px; margin-left:4px; }\n.dup-tag { background:#FFF0A0; color:#7D5A00; font-size:9px; font-weight:700;\n  padding:2px 7px; border-radius:20px; margin-left:4px; }\n.req-title { font-size:15px; font-weight:700; line-height:1.3; margin-bottom:4px; }\n.req-meta { font-size:13px; color:var(--muted); line-height:1.7; }\n.req-notes { font-size:12px; color:var(--muted); font-style:italic; margin-top:4px; line-height:1.5; }\n.req-time { font-size:11px; color:#C0BAB0; margin-top:5px; }\n.del-btn { background:none; border:none; font-size:18px; color:#DDD;\n  padding:4px 8px; cursor:pointer; flex-shrink:0; }\n.del-btn:active { color:var(--buy); }\n\n/* ── MATCH SECTION ── */\n.match-section { margin-top:10px; border-top:1px solid var(--line); padding-top:10px; }\n.match-toggle { font-size:12px; font-weight:700; color:var(--accent);\n  letter-spacing:.04em; text-transform:uppercase; display:flex;\n  align-items:center; justify-content:space-between; cursor:pointer; }\n.match-body { display:none; margin-top:8px; }\n.match-body.open { display:block; }\n.match-row { padding:8px 0; border-bottom:1px solid #F5F0E8; display:flex;\n  justify-content:space-between; align-items:flex-start; gap:8px; }\n.match-row:last-child { border:none; }\n.match-info { flex:1; font-size:13px; line-height:1.5; }\n.match-why { font-size:11px; color:var(--muted); margin-top:2px; }\n.score { font-weight:800; font-size:11px; padding:3px 8px; border-radius:20px;\n  color:#fff; white-space:nowrap; }\n\n/* ── ALERT BANNER ── */\n.alert-wrap { padding:0 14px; }\n.alert { border-radius:14px; padding:14px; margin-bottom:10px;\n  animation:slideDown .3s ease; }\n@keyframes slideDown { from{opacity:0;transform:translateY(-10px);} to{opacity:1;transform:none;} }\n.alert.match { background:#EAF4ED; border:2px solid var(--sell); }\n.alert.dup { background:#FFF8E6; border:1px solid var(--gold); }\n.alert.saved { background:#FBF3E8; border:1px solid #C9A96E; }\n.alert.wa { background:#E8F4FB; border:1px solid var(--rh); }\n.alert-title { font-weight:800; font-size:14px; margin-bottom:5px; }\n.alert.match .alert-title { color:var(--sell); }\n.alert.dup .alert-title { color:#7D5A00; }\n.alert.saved .alert-title { color:var(--accent); }\n.alert.wa .alert-title { color:var(--rh); }\n.alert-body { font-size:13px; line-height:1.7; color:#333; }\n.pulse { display:inline-block; width:8px; height:8px; border-radius:50%;\n  background:var(--sell); animation:pulse 1.2s infinite; margin-right:5px; }\n@keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.2;} }\n\n/* ── PARSED PREVIEW ── */\n.preview-box { background:#FBF6EE; border:2px dashed var(--accent);\n  border-radius:12px; padding:14px; margin-top:12px; }\n.preview-item { padding:8px 0; border-bottom:1px solid #EDE7D9; font-size:13px; line-height:1.7; }\n.preview-item:last-child { border:none; }\n.preview-actions { display:flex; gap:10px; margin-top:12px; }\n.preview-actions .btn { flex:1; padding:12px; }\n\n/* ── CHAT ── */\n.chat-screen { display:flex; flex-direction:column; height:100%; }\n.chat-msgs { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;\n  padding:14px; display:flex; flex-direction:column; gap:10px; background:var(--bg); }\n.msg { max-width:82%; padding:10px 14px; border-radius:18px; font-size:14px; line-height:1.5; }\n.msg.user { background:var(--ink); color:#fff; align-self:flex-end;\n  border-bottom-right-radius:4px; }\n.msg.ai { background:var(--card); color:var(--ink); align-self:flex-start;\n  border-bottom-left-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,.06); }\n.msg.thinking { opacity:.5; font-style:italic; }\n.chat-input-bar {\n  background:var(--card); border-top:1px solid var(--line);\n  padding:10px 14px; display:flex; gap:8px; align-items:flex-end;\n  flex-shrink:0;\n}\n.chat-text { flex:1; border:1.5px solid var(--line); border-radius:22px;\n  padding:10px 16px; font-size:15px; font-family:inherit; background:#FCFAF5;\n  resize:none; max-height:80px; outline:none; }\n.chat-text:focus { border-color:var(--accent); }\n.chat-send { background:var(--accent); color:#fff; border:none; border-radius:50%;\n  width:42px; height:42px; font-size:18px; cursor:pointer; flex-shrink:0;\n  display:flex; align-items:center; justify-content:center; }\n.chat-send:active { opacity:.75; }\n\n/* ── SERVER CONNECT SHEET ── */\n.server-row { display:flex; gap:8px; align-items:center; }\n.server-input { flex:1; border:1.5px solid var(--line); border-radius:10px;\n  padding:10px 12px; font-size:13px; background:#FCFAF5; font-family:inherit; }\n.connect-btn { background:var(--accent); color:#fff; border:none; border-radius:10px;\n  padding:10px 14px; font-weight:700; font-size:13px; cursor:pointer; white-space:nowrap; }\n\n/* ── EMPTY STATE ── */\n.empty { text-align:center; padding:60px 20px; color:var(--muted); }\n.empty-ico { font-size:50px; margin-bottom:12px; }\n.empty-msg { font-size:15px; line-height:1.6; }\n\n/* ── INSTALL BANNER ── */\n.install-banner {\n  background:var(--ink); color:#fff; padding:12px 16px;\n  display:flex; align-items:center; justify-content:space-between; gap:10px;\n  font-size:13px;\n}\n.install-banner b { color:var(--gold); }\n.install-close { background:none; border:none; color:#aaa; font-size:18px; cursor:pointer; }\n\n/* ── MISC ── */\n::-webkit-scrollbar { display:none; }\ninput[type="number"] { -moz-appearance:textfield; }\ninput[type="number"]::-webkit-outer-spin-button,\ninput[type="number"]::-webkit-inner-spin-button { -webkit-appearance:none; }\n</style>\n</head>\n<body>\n\n<!-- INSTALL BANNER (shown if not in standalone mode) -->\n<div class="install-banner" id="installBanner" style="display:none;">\n  <span>📲 Add to Home Screen — tap <b>Share</b> then <b>"Add to Home Screen"</b></span>\n  <button class="install-close" onclick="document.getElementById(\'installBanner\').style.display=\'none\'">✕</button>\n</div>\n\n<!-- NAVBAR -->\n<div class="navbar">\n  <div class="nav-brand">\n    <div class="nav-mark">PM</div>\n    <div class="nav-title">PlotMatch</div>\n  </div>\n  <div class="nav-right">\n    <div class="dot" id="dot"></div>\n    <span id="syncLbl">Offline</span>\n  </div>\n</div>\n\n<!-- SCREENS -->\n<div class="screen-wrap">\n\n  <!-- BOARD SCREEN -->\n  <div class="screen active" id="screen-board">\n    <div class="alert-wrap" id="alertBox"></div>\n    <div class="stats-row" id="statsRow"></div>\n    <div class="search-wrap">\n      <div class="search-bar">\n        <input class="search-input" id="search" placeholder="🔍 Search locality, contact…" oninput="render()">\n        <select class="filter-btn" id="ftType" onchange="render()">\n          <option value="">All</option>\n          <option value="buy">Buy</option>\n          <option value="sell">Sell</option>\n          <option value="rent_want">Rent Want</option>\n          <option value="rent_have">Rent Have</option>\n        </select>\n      </div>\n    </div>\n    <div class="req-list" id="listBox"></div>\n  </div>\n\n  <!-- PASTE SCREEN -->\n  <div class="screen" id="screen-paste">\n    <div class="page-pad">\n      <div class="card">\n        <div class="section-title">Paste WhatsApp Message</div>\n        <div class="field">\n          <textarea id="rawInput" placeholder="Paste any message — Hindi, English, Hinglish all work.\n\nSingle or multiple listings in one go.\n\nExample:\nUrgent sell Sector 21A 250 gaj plot\nnorth facing 1.5 cr Sharma ji 9811XXXXXX"></textarea>\n        </div>\n        <button class="btn btn-primary" id="parseBtn" onclick="parseMessage()">Parse with AI →</button>\n        <div id="parsedBox"></div>\n      </div>\n\n      <div class="card">\n        <div class="section-title">AI understands</div>\n        <div style="font-size:13px; color:var(--muted); line-height:1.9;">\n          Plot · Floor · Flat · Builder Floor · Kothi · File · BHK ·\n          Gaj / Sq.Yd · Sq.Ft · Marla · Kanal · Biswa ·\n          North/South/East/West · Corner · Park Facing ·\n          @Rate/sq.yd · Cr / Lac · Registry · NOC · Stilt+4 ·\n          Numbered & bulleted lists · Context shifts (rent→sell) ·\n          HUDA / HSVP sectors\n        </div>\n      </div>\n\n      <!-- SERVER CONNECT -->\n      <div class="card">\n        <div class="section-title">Server Connection</div>\n        <div class="server-row">\n          <input class="server-input" id="serverUrl" value="https://plotmatch-server.onrender.com" placeholder="Server URL">\n          <button class="connect-btn" onclick="connect()">Connect</button>\n        </div>\n      </div>\n    </div>\n  </div>\n\n  <!-- ADD SCREEN -->\n  <div class="screen" id="screen-add">\n    <div class="page-pad">\n      <div class="card">\n        <div class="section-title">Add Manually</div>\n        <div class="field"><label>Type</label>\n          <select id="f_type">\n            <option value="buy">🔴 Buyer — wants to purchase</option>\n            <option value="sell">🟢 Seller — has property</option>\n            <option value="rent_want">🟡 Rent Wanted</option>\n            <option value="rent_have">🔵 Rent Available</option>\n          </select>\n        </div>\n        <div class="two">\n          <div class="field"><label>Category</label>\n            <select id="f_cat">\n              <option>Plot</option><option>Floor</option><option>Flat</option>\n              <option>House</option><option>Shop</option><option>Office</option><option>Other</option>\n            </select>\n          </div>\n          <div class="field"><label>BHK / Floor</label>\n            <input id="f_bhk" placeholder="3BHK">\n          </div>\n        </div>\n        <div class="field"><label>Locality / Sector *</label>\n          <input id="f_loc" placeholder="Sector 21A, NIT…">\n        </div>\n        <div class="field"><label>Sub-area (Block/Phase)</label>\n          <input id="f_sub" placeholder="W Block, Phase 2…">\n        </div>\n        <div class="three">\n          <div class="field"><label>Size</label>\n            <input id="f_size" type="number" placeholder="250">\n          </div>\n          <div class="field"><label>Unit</label>\n            <select id="f_unit">\n              <option>sq.yd</option><option>sq.ft</option>\n              <option>marla</option><option>kanal</option><option>acre</option>\n            </select>\n          </div>\n          <div class="field"><label>Facing</label>\n            <select id="f_facing">\n              <option value="">Any</option><option>North</option><option>South</option>\n              <option>East</option><option>West</option><option>Corner</option>\n              <option>Park-Facing</option>\n            </select>\n          </div>\n        </div>\n        <div class="two">\n          <div class="field"><label>Budget Min ₹</label>\n            <input id="f_bmin" placeholder="10000000">\n          </div>\n          <div class="field"><label>Budget Max ₹</label>\n            <input id="f_bmax" placeholder="15000000">\n          </div>\n        </div>\n        <div class="field"><label>Contact Name &amp; Phone *</label>\n          <input id="f_contact" placeholder="Sharma ji 9811XXXXXX">\n        </div>\n        <div class="field"><label>Notes</label>\n          <input id="f_notes" placeholder="Registry, NOC, 30ft road…">\n        </div>\n        <button class="btn btn-primary" onclick="addManual()">Add to Board</button>\n      </div>\n    </div>\n  </div>\n\n  <!-- AI CHAT SCREEN -->\n  <div class="screen" id="screen-ai">\n    <div class="chat-screen">\n      <div class="chat-msgs" id="chatMsgs">\n        <div class="msg ai">Namaste! 🏡 Main PlotMatch AI hoon.<br><br>Aap pooch sakte hain:<br>• "Sector 21 mein koi buyer hai?"<br>• "5 marla kitne sq.yd?"<br>• "Today\'s best matches?"<br>• Any property question in Hindi/English</div>\n      </div>\n      <div class="chat-input-bar">\n        <textarea class="chat-text" id="chatIn" placeholder="Ask anything…" rows="1"\n          onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();sendChat();}"\n          oninput="this.style.height=\'auto\';this.style.height=Math.min(this.scrollHeight,80)+\'px\'"></textarea>\n        <button class="chat-send" onclick="sendChat()">↑</button>\n      </div>\n    </div>\n  </div>\n\n</div>\n\n<!-- BOTTOM TAB BAR -->\n<div class="tabbar">\n  <button class="tab-item active" id="tab-board" onclick="switchScreen(\'board\')">\n    <div class="tab-icon" style="position:relative;">🏘️<span class="tab-badge" id="badge" style="display:none;"></span></div>\n    <span>Board</span>\n  </button>\n  <button class="tab-item" id="tab-paste" onclick="switchScreen(\'paste\')">\n    <div class="tab-icon">📋</div>\n    <span>Paste</span>\n  </button>\n  <button class="tab-item" id="tab-add" onclick="switchScreen(\'add\')">\n    <div class="tab-icon">＋</div>\n    <span>Add</span>\n  </button>\n  <button class="tab-item" id="tab-ai" onclick="switchScreen(\'ai\')">\n    <div class="tab-icon">🤖</div>\n    <span>AI Agent</span>\n  </button>\n</div>\n\n<script>\n// ── STATE ──────────────────────────────────────────────────────────────\nlet SERVER = \'https://plotmatch-server.onrender.com\';\nlet DATA = [];\nlet serverOnline = false;\nlet pollingTimer = null;\nlet newCount = 0;\n\n// ── STORAGE ────────────────────────────────────────────────────────────\nfunction save(){ try{ localStorage.setItem(\'pm_ios_v1\', JSON.stringify(DATA)); }catch(e){} }\nfunction load(){ try{ const d=localStorage.getItem(\'pm_ios_v1\')||localStorage.getItem(\'pm_data_v2\'); return d?JSON.parse(d):[]; }catch(e){ return []; } }\n\nfunction freshnessColor(ts){\n  const days = (Date.now()-ts)/(1000*60*60*24);\n  if(days<=1) return \'#1A6B3C\';   // green — today\n  if(days<=3) return \'#C9A227\';   // orange — 1-3 days\n  return \'#C0392B\';               // red — older than 3 days\n}\nfunction freshnessLabel(ts){\n  const days = (Date.now()-ts)/(1000*60*60*24);\n  if(days<=1) return \'🟢 Fresh\';\n  if(days<=3) return \'🟡 \'+Math.floor(days)+\'d old\';\n  return \'🔴 \'+Math.floor(days)+\'d old — verify first\';\n}\nfunction uid(){ return \'r\'+Date.now()+Math.random().toString(36).slice(2,6); }\n\n// ── SCREEN SWITCHING ───────────────────────────────────────────────────\nfunction switchScreen(name){\n  document.querySelectorAll(\'.screen\').forEach(s => s.classList.remove(\'active\'));\n  document.querySelectorAll(\'.tab-item\').forEach(t => t.classList.remove(\'active\'));\n  document.getElementById(\'screen-\'+name).classList.add(\'active\');\n  document.getElementById(\'tab-\'+name).classList.add(\'active\');\n  if(name === \'board\'){ newCount=0; updateBadge(); }\n}\n\nfunction updateBadge(){\n  const b = document.getElementById(\'badge\');\n  if(newCount>0){ b.textContent=newCount; b.style.display=\'flex\'; }\n  else b.style.display=\'none\';\n}\n\n// ── SERVER ─────────────────────────────────────────────────────────────\nfunction setStatus(ok, msg){\n  document.getElementById(\'dot\').className = \'dot \'+(ok?\'ok\':\'err\');\n  document.getElementById(\'syncLbl\').textContent = msg;\n  serverOnline = ok;\n}\n\nasync function connect(){\n  SERVER = document.getElementById(\'serverUrl\').value.trim().replace(/\\/$/,\'\');\n  setStatus(false, \'Connecting…\');\n  try{\n    const r = await fetch(SERVER+\'/\', {signal:AbortSignal.timeout(8000)});\n    if(!r.ok) throw new Error(\'HTTP \'+r.status);\n    serverOnline = true;\n    setStatus(true, \'Live ✓\');\n    startPolling();\n    await pollInbox();\n  }catch(e){\n    setStatus(false, \'Offline\');\n  }\n}\n\nfunction startPolling(){\n  if(pollingTimer) clearInterval(pollingTimer);\n  pollingTimer = setInterval(pollInbox, 20000);\n}\n\nasync function pollInbox(){\n  if(!serverOnline) return;\n  try{\n    const r = await fetch(SERVER+\'/inbox\');\n    const d = await r.json();\n    if(d.items && d.items.length>0){\n      for(const msg of d.items) await processWA(msg);\n    }\n  }catch(e){\n    serverOnline=false;\n    setStatus(false,\'Lost connection\');\n  }\n}\n\nasync function processWA(msg){\n  const added=[];\n  for(const l of (msg.listings||[])){\n    const item = buildItem(l, msg.rawText, msg.source||\'whatsapp\', msg.name||msg.from, msg.receivedAt);\n    item.groupName = msg.groupName || msg.chatName || \'\';\n    if (msg.postedAt) item.createdAt = msg.postedAt;\n    const r = addToData(item);\n    if(r.added) added.push(r);\n  }\n  if(added.length>0){\n    save();\n    newCount += added.length;\n    updateBadge();\n    render();\n    const matches = added.filter(r=>r.matches.length>0);\n    if(matches.length>0) showMatchAlert(matches.flatMap(r=>r.matches));\n    else showAlert(\'wa\',\'📱 WhatsApp\',`${added.length} new listing(s) from ${msg.name||\'group\'} saved.`);\n  }\n}\n\n// ── FORMATTING ─────────────────────────────────────────────────────────\nfunction fmtINR(n){\n  if(!n) return \'\';\n  if(n>=10000000) return \'₹\'+(n/10000000).toFixed(2).replace(/\\.?0+$/,\'\')+\' Cr\';\n  if(n>=100000)   return \'₹\'+(n/100000).toFixed(1).replace(/\\.?0+$/,\'\')+\' L\';\n  return \'₹\'+n.toLocaleString(\'en-IN\');\n}\nfunction fmtBudget(min,max){\n  if(min&&max) return fmtINR(min)+\' – \'+fmtINR(max);\n  if(max) return \'upto \'+fmtINR(max);\n  if(min) return fmtINR(min)+\'+\';\n  return \'\';\n}\nfunction fmtDT(ts){\n  const d=new Date(ts);\n  const p=n=>String(n).padStart(2,\'0\');\n  return p(d.getDate())+\'/\'+p(d.getMonth()+1)+\'/\'+d.getFullYear()+\' \'+p(d.getHours())+\':\'+p(d.getMinutes());\n}\nfunction ago(ts){\n  const s=Math.floor((Date.now()-ts)/1000);\n  if(s<60) return \'just now\';\n  if(s<3600) return Math.floor(s/60)+\'m ago\';\n  if(s<86400) return Math.floor(s/3600)+\'h ago\';\n  return Math.floor(s/86400)+\'d ago\';\n}\nfunction typeLabel(t){\n  return {buy:\'BUYER\',sell:\'SELLER\',rent_want:\'RENT WANTED\',rent_have:\'RENT AVAILABLE\'}[t]||t.toUpperCase();\n}\n\n// ── DUPLICATE DETECTION ────────────────────────────────────────────────\nfunction normPhone(s){ return (s||\'\').replace(/[^0-9]/g,\'\').slice(-10); }\nfunction normLoc(s){ return (s||\'\').toLowerCase().replace(/[^a-z0-9]/g,\'\'); }\n\nfunction isDup(a,b){\n  if(a.id===b.id) return false;\n  if(a.rawText&&b.rawText&&a.rawText.trim().toLowerCase()===b.rawText.trim().toLowerCase()) return true;\n  const pa=normPhone(a.contact), pb=normPhone(b.contact);\n  if(pa.length>=8&&pa===pb){\n    const sT=a.type===b.type, sL=normLoc(a.locality)===normLoc(b.locality),\n          sC=!a.category||!b.category||a.category===b.category,\n          sS=(!a.size||!b.size)||Math.abs(a.size-b.size)/Math.max(a.size,b.size)<0.15,\n          sB=(!a.budgetMax||!b.budgetMax)||Math.abs(a.budgetMax-b.budgetMax)/Math.max(a.budgetMax,b.budgetMax)<0.15;\n    if(sT&&sL&&sC&&sS&&sB) return true;\n  }\n  return false;\n}\n\n// ── MATCHING ───────────────────────────────────────────────────────────\nfunction toSqYd(size,unit){\n  if(!size) return 0;\n  if(unit===\'sq.ft\') return size/9;\n  if(unit===\'marla\') return size*30.25;\n  if(unit===\'kanal\') return size*605;\n  if(unit===\'acre\')  return size*4840;\n  return size;\n}\n\nfunction scoreMatch(a,b){\n  const valid=(a.type===\'buy\'&&b.type===\'sell\')||(a.type===\'sell\'&&b.type===\'buy\')||\n              (a.type===\'rent_want\'&&b.type===\'rent_have\')||(a.type===\'rent_have\'&&b.type===\'rent_want\');\n  if(!valid) return {score:0};\n  const buyer=(a.type===\'buy\'||a.type===\'rent_want\')?a:b;\n  const seller=(a.type===\'buy\'||a.type===\'rent_want\')?b:a;\n  let sc=0; const why=[];\n  const la=normLoc(a.locality), lb=normLoc(b.locality);\n  if(!la||!lb) return {score:0};\n  const nA=(la.match(/\\d+/)||[])[0], nB=(lb.match(/\\d+/)||[])[0];\n  if(la===lb){sc+=40;why.push(\'Exact locality ✓\');}\n  else if(la.includes(lb)||lb.includes(la)){sc+=30;why.push(\'Locality overlaps\');}\n  else if(nA&&nA===nB){sc+=18;why.push(\'Same sector #\');}\n  else return {score:0};\n  if(a.category&&b.category&&a.category!==b.category) return {score:0};\n  if(a.category&&a.category===b.category){sc+=12;why.push(a.category+\' ✓\');}\n  const bMax=buyer.budgetMax||buyer.budgetMin||0, sAsk=seller.budgetMax||seller.budgetMin||0;\n  if(bMax&&sAsk){\n    if(bMax>=sAsk*.95){sc+=30;why.push(\'Budget fits ✓\');}\n    else if(bMax>=sAsk*.8){sc+=18;why.push(\'Budget ~close\');}\n    else if(bMax>=sAsk*.65){sc+=8;why.push(\'Budget gap ~\'+Math.round((1-bMax/sAsk)*100)+\'%\');}\n  }\n  if(a.size&&b.size){\n    const diff=Math.abs(toSqYd(a.size,a.unit)-toSqYd(b.size,b.unit))/Math.max(toSqYd(a.size,a.unit),toSqYd(b.size,b.unit));\n    if(diff<=.05){sc+=15;why.push(\'Size exact ✓\');}\n    else if(diff<=.2){sc+=9;why.push(\'Size ±\'+Math.round(diff*100)+\'%\');}\n    else if(diff<=.4){sc+=4;}\n  }\n  if(a.bhk&&b.bhk&&a.bhk.toLowerCase()===b.bhk.toLowerCase()){sc+=8;why.push(\'BHK ✓\');}\n  if(a.facing&&b.facing&&a.facing===b.facing){sc+=5;why.push(a.facing+\' ✓\');}\n  return {score:Math.min(100,Math.round(sc)),why};\n}\n\nfunction getMatches(item){\n  return DATA.map(d=>({d,...scoreMatch(item,d)})).filter(m=>m.score>=25).sort((a,b)=>b.score-a.score).slice(0,5);\n}\nfunction scoreColor(s){ return s>=75?\'#1A6B3C\':s>=55?\'#2C6B8A\':s>=35?\'#C9A227\':\'#999\'; }\n\n// ── BUILD & ADD ────────────────────────────────────────────────────────\nfunction buildItem(l, rawText, source, contact, createdAt){\n  return {\n    id:uid(), type:l.type||\'sell\', category:l.category||\'\', bhk:l.bhk||\'\',\n    locality:l.locality||\'\', subLocality:l.subLocality||\'\',\n    size:l.size||null, unit:l.unit||\'\', budgetMin:l.budgetMin||null, budgetMax:l.budgetMax||null,\n    facing:l.facing||\'\', contact:l.contact||contact||\'\', notes:l.notes||\'\',\n    rawText:rawText||\'\', source:source||\'dashboard\', createdAt:createdAt||Date.now()\n  };\n}\n\nfunction addToData(item){\n  const dupOf=DATA.find(d=>isDup(item,d));\n  if(dupOf) return {added:false,dup:true};\n  DATA.unshift(item);\n  const matches=getMatches(item).filter(m=>m.score>=55).map(m=>({\n    buyer:(item.type===\'buy\'||item.type===\'rent_want\')?item:m.d,\n    seller:(item.type===\'buy\'||item.type===\'rent_want\')?m.d:item,\n    score:m.score, why:m.why\n  }));\n  return {added:true,item,matches};\n}\n\n// ── PARSE WITH AI ──────────────────────────────────────────────────────\nasync function parseMessage(){\n  const raw = document.getElementById(\'rawInput\').value.trim();\n  if(!raw) return;\n  const btn = document.getElementById(\'parseBtn\');\n  btn.disabled=true; btn.textContent=\'Reading…\';\n  try{\n    const res = await fetch(\'https://api.anthropic.com/v1/messages\',{\n      method:\'POST\', headers:{\'Content-Type\':\'application/json\'},\n      body:JSON.stringify({\n        model:\'claude-sonnet-4-6\', max_tokens:4000,\n        system:`You are an expert real-estate message interpreter for Faridabad/NCR, Haryana, India.\n\nTYPE: "buy"=wants to purchase (chahiye/required/looking for), "sell"=wants to sell (for sale/available/price quoted), "rent_want"=wants to rent, "rent_have"=has property to rent out\nCONTEXT SHIFT: If someone changed intent, extract current intent only, note the shift.\nMIXED INTENT: Same message can have both buy and sell items — classify each individually.\n\nPRICE: @69000/sq.yd × size = total. "2 .10 Cr"=21000000. "@1.35"=13500000. "@1.60/yd"=1.60L×size. "2.25cr-2.35cr"=budgetMin+Max. Rent "20-30"=20000-30000/month. 1cr=10000000, 1lac=100000.\nBPTP PRICE: "@450Reg"/"@355Reg" = TOTAL price in LAKHS → budgetMax=450×100000=45000000. "@205000 per sqyrd" = rate per sq.yd → budgetMax=size×205000. "Reg" suffix=Registry→notes. "naksha passed"=map approved→notes. "east+park"=East+Park facing. "D-250sy"=Block D 250 sq.yd→subLocality=D Block. "sy"/"SY"=sq.yd. Skip "MORE OPTIONS"/"PLS CALL" lines.\n\nCRITICAL EXTRACTION RULES:\n- NUMBERED EMOJI BOXES (1️⃣ 2️⃣ 3️⃣) = each is a SEPARATE listing. 📍 pin emoji also = SEPARATE. Numbers may reset per section — still extract each separately\n- EMOJI BULLETS (👉 ✅ 🔹 🙏 ➡️ ⚡ 💥 ☞ ✔️) = each emoji line is SEPARATE\n- WHATSAPP BOLD (*text*) — strip asterisks. Bold-only line with no size/price = section header\n- SECTION HEADERS: line with just society/location name ("Bptp plots","Huda sector 77","Amolik Asterwood 98","Puri Kohinoor","Bptp Villa") = locality for all items below until next header\n- NUMBERED LISTS (1. 2. 3.) = each is SEPARATE\n- NEVER merge multiple properties into one object\n- Contact/phone at VERY BOTTOM applies to ALL listings above\n- BPTP PLOT CODES: "PA110"=P-A Block, "W11-24"=W Block, "M5-15"=M Block, "F3-18"=F Block → subLocality\n- "FOR SALE"/"Confirmed"/"Available" header = all below are type=sell\n- "Urgent required"/"chahiye"/"looking for" = type=buy even in sell-heavy message\n- SCO = Shop Cum Office → category=Shop\n- gaj=sq.yd. sqyd=sq.yd. Sqft/SF=sq.ft. Marla=272sq.ft. Kanal=20 marla.\n- Notes: NOC, registry, corner, park facing, furnished, terrace, basement, pool, stilt+4, map approved\n\nSECTION HEADER EMOJIS: 🏛️ and 🛣️ on the SAME line as society name = section header\n- "🏛️*Discovery park*" = Discovery Park is the society/locality for all ➡️ items below\n- "🛣️*Adore Exclusive Sec -86*" = Adore Exclusive, Sector 86 is locality\n- Sub-items under the header use ➡️ 👉 💥 emojis = each is a SEPARATE listing\n\nBHK FORMAT WITH EXTRA ROOMS:\n- "2+2" = 2BHK + 2 extra rooms → bhk="2+2 BHK"\n- "3+2" = 3BHK + 2 extra rooms → bhk="3+2 BHK"\n- "3+3" = 3BHK + 3 extra rooms → bhk="3+3 BHK"\n- "3+1" = 3BHK + 1 servant room → bhk="3+1 BHK"\n- "2+1" = 2BHK + 1 servant room → bhk="2+1 BHK"\n\nFURNISHING SHORTHAND:\n- "Semi" = Semi-furnished → notes="Semi-furnished"\n- "Raw" = Unfurnished/bare → notes="Raw/Unfurnished"\n- "GF" = Ground Floor → notes="Ground Floor"\n- "Lower" = Lower ground floor → notes="Lower ground floor"\n- "4th +roof" = 4th floor with roof rights → notes="4th floor with roof rights"\n- "Double Storey" = G+1 construction → notes="Double Storey"\n- "Single Storey" = Ground floor only → notes="Single Storey"\n\nBUILDER FLOOR SHORTHAND:\n- "B.p.home" or "BP home" or "B.P.Home" = Builder\'s property / Builder Floor → category="Floor"\n\nSECTOR FORMAT WITH DASH:\n- "Sec -76" or "Sec-76" = Sector 76 (dash is just formatting, not subtraction)\n- "Sec -86" = Sector 86\n\nPRICE FORMAT:\n- "@ .1.45cr" = typo for 1.45cr = 14500000 (extra dot before number, ignore it)\n- "@ 70Lac" or "@ 68Lac" = 70 lakh = 7000000, 68 lakh = 6800000\n\nCONTACT: "Vishwas properties / Jatin Sharma / 9319000940" = all three lines = one contact entry\n\n\n\nEMOJI FIELD LABELS (within a single listing, these label attributes — NOT new listings):\n- 📍 = property name/location (START of a new listing)\n- 📐 = size field ("📐 Size: 250 Gaj" → size=250, unit=sq.yd)\n- 🏢 🏠 🏡 = floor/building type ("🏢 Second Floor" → bhk="2nd Floor", category=Floor)\n- 🌞 ☀️ = orientation/open sides ("🌞 3-Side Open" → notes="3-Side Open")\n- 🛋️ 🪑 = furnishing ("🛋️ Semi-Furnished" → notes="Semi-Furnished")\n- 💰 💵 = price/demand/rent ("💰 Demand: ₹1.10 Crore" → budgetMax=11000000)\n- 📞 📱 ☎️ = contact field ("📞 Contact: Deeana Estates" → contact)\n- So 📍 = new listing boundary. Everything between two 📍 = one listing.\n\nMID-MESSAGE INTENT SWITCH:\n- "🏡 FOR RENT" or "FOR RENT" appearing after a FOR SALE section = new section, all below are rent_have\n- "🏡 FOR SALE" or "FOR SALE" appearing after a FOR RENT section = new section, all below are sell\n- Both can appear in ONE message — extract each section with correct type\n\nFIELD FORMAT TRAINING:\n- "Demand: ₹1.10 Crore" = budgetMax=11000000\n- "Demand: ₹1.10 crore" = same\n- "Size: 250 Gaj" = size=250, unit=sq.yd (Gaj=sq.yd)\n- "Second Floor" / "Ground Floor" / "1st Floor" = bhk field + category=Floor\n- "3-Side Open" / "Two Side Open" / "Corner" = notes\n- "Mobile: 9540391969" = contact phone\n- "DEEANA ESTATES" all caps line = company name, part of contact\n\nLEFT-POINTING EMOJIS: 👈 👈🏻 👈🏼 👈🏽 👈🏾 👈🏿 (pointing left, with any skin tone) = same as 👉, treat as bullet or emphasis marker\nSKIN TONE EMOJI VARIANTS: Any emoji with 🏻🏼🏽🏾🏿 modifier = same as base emoji\n"Party confirm" / "Confirm party" = the client is verified/serious — NOT a separate listing, add to notes of previous listing as "Confirmed party"\n"Only WhatsApp call SMS" = contact instruction, not a listing — add to contact notes\n"District A B Block" = BPTP District, A Block and B Block → locality="Sector 81 Faridabad", subLocality="District A-B Block"\n"SGA" at end of message = sender\'s initials, not a listing — skip\n\nRETURN ONLY raw JSON array, no markdown:\n[{"type":"buy|sell|rent_want|rent_have","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|Park-Facing","contact":"","notes":""}]`,\n        messages:[{role:\'user\',content:raw}]\n      })\n    });\n    const data = await res.json();\n    const txt = (data.content||[]).map(b=>b.text||\'\').join(\'\');\n    const arr = JSON.parse(txt.replace(/```json|```/g,\'\').trim());\n    showParsed(Array.isArray(arr)?arr:[arr], raw);\n  }catch(e){\n    document.getElementById(\'parsedBox\').innerHTML=`<div class="preview-box" style="color:var(--buy);">⚠️ ${e.message}</div>`;\n  }finally{ btn.disabled=false; btn.textContent=\'Parse with AI →\'; }\n}\n\nfunction showParsed(listings, raw){\n  const items = listings.map(l=>`\n    <div class="preview-item">\n      <b>${typeLabel(l.type)} · ${l.category||\'Property\'} ${l.bhk||\'\'}</b><br>\n      📍 ${l.locality||\'—\'} ${l.subLocality?\'(\'+l.subLocality+\')\':\'\'}<br>\n      📐 ${l.size?l.size+\' \'+l.unit:\'—\'} ${l.facing?\'· \'+l.facing:\'\'}<br>\n      💰 ${fmtBudget(l.budgetMin,l.budgetMax)||\'—\'}<br>\n      📞 ${l.contact||\'—\'}\n      ${l.notes?\'<br>📝 <i>\'+l.notes+\'</i>\':\'\'}\n    </div>`).join(\'\');\n  document.getElementById(\'parsedBox\').innerHTML=`\n    <div class="preview-box">\n      <b style="color:var(--sell)">✓ ${listings.length} listing(s)</b>\n      ${items}\n      <div class="preview-actions">\n        <button class="btn btn-primary" onclick=\'confirmAdd(${JSON.stringify(listings)},${JSON.stringify(raw)})\'>Save all</button>\n        <button class="btn btn-ghost" onclick="clearPaste()">Discard</button>\n      </div>\n    </div>`;\n}\n\nfunction clearPaste(){\n  document.getElementById(\'rawInput\').value=\'\';\n  document.getElementById(\'parsedBox\').innerHTML=\'\';\n}\n\nasync function confirmAdd(listings, raw){\n  const results=[];\n  for(const l of listings){\n    const item=buildItem(l,raw,\'whatsapp-paste\');\n    results.push(addToData(item));\n  }\n  save();\n  clearPaste();\n  switchScreen(\'board\');\n  const dups=results.filter(r=>r.dup).length;\n  const added=results.filter(r=>r.added);\n  const withMatches=added.filter(r=>r.matches.length>0);\n  if(dups>0) showAlert(\'dup\',\'⚠️ Duplicate\',`${dups} duplicate(s) blocked.`);\n  if(withMatches.length>0) showMatchAlert(withMatches.flatMap(r=>r.matches));\n  else if(added.length>0) showAlert(\'saved\',\'✅ Saved\',`${added.length} listing(s) added.`);\n  render();\n}\n\n// ── MANUAL ADD ─────────────────────────────────────────────────────────\nfunction addManual(){\n  const loc=document.getElementById(\'f_loc\').value.trim();\n  if(!loc){ document.getElementById(\'f_loc\').focus(); return; }\n  const l={\n    type:document.getElementById(\'f_type\').value,\n    category:document.getElementById(\'f_cat\').value,\n    bhk:document.getElementById(\'f_bhk\').value.trim(),\n    locality:loc,\n    subLocality:document.getElementById(\'f_sub\').value.trim(),\n    size:parseFloat(document.getElementById(\'f_size\').value)||null,\n    unit:document.getElementById(\'f_unit\').value,\n    budgetMin:parseFloat((document.getElementById(\'f_bmin\').value||\'\').replace(/,/g,\'\'))||null,\n    budgetMax:parseFloat((document.getElementById(\'f_bmax\').value||\'\').replace(/,/g,\'\'))||null,\n    facing:document.getElementById(\'f_facing\').value,\n    contact:document.getElementById(\'f_contact\').value.trim(),\n    notes:document.getElementById(\'f_notes\').value.trim()\n  };\n  const item=buildItem(l,\'\',\'dashboard\');\n  const r=addToData(item);\n  save();\n  if(r.dup){ showAlert(\'dup\',\'⚠️ Duplicate\',\'Similar entry already exists.\'); return; }\n  if(r.matches.length>0) showMatchAlert(r.matches);\n  else showAlert(\'saved\',\'✅ Saved\',l.category+\' in \'+loc);\n  [\'f_bhk\',\'f_loc\',\'f_sub\',\'f_size\',\'f_bmin\',\'f_bmax\',\'f_contact\',\'f_notes\'].forEach(id=>document.getElementById(id).value=\'\');\n  switchScreen(\'board\');\n  render();\n}\n\n// ── ALERTS ─────────────────────────────────────────────────────────────\nlet alertTimer=null;\nfunction showAlert(type,title,msg){\n  const box=document.getElementById(\'alertBox\');\n  box.innerHTML+=`<div class="alert ${type}"><div class="alert-title">${title}</div><div class="alert-body">${msg}</div></div>`;\n  if(alertTimer) clearTimeout(alertTimer);\n  alertTimer=setTimeout(()=>box.innerHTML=\'\',8000);\n}\nfunction showMatchAlert(matches){\n  const html=matches.map(m=>`\n    <div class="alert match">\n      <div class="alert-title"><span class="pulse"></span>MUTUAL MATCH — ${m.score}%</div>\n      <div class="alert-body">\n        <b>Buyer:</b> ${m.buyer.contact||\'—\'} · ${m.buyer.category||\'\'} ${m.buyer.bhk||\'\'} in ${m.buyer.locality||\'—\'} · ${fmtBudget(m.buyer.budgetMin,m.buyer.budgetMax)}<br>\n        <b>Seller:</b> ${m.seller.contact||\'—\'} · ${m.seller.category||\'\'} ${m.seller.bhk||\'\'} in ${m.seller.locality||\'—\'} · ${fmtBudget(m.seller.budgetMin,m.seller.budgetMax)}<br>\n        <b>Why:</b> ${(m.why||[]).join(\' · \')}\n      </div>\n    </div>`).join(\'\');\n  document.getElementById(\'alertBox\').innerHTML=html;\n}\n\n// ── DELETE ─────────────────────────────────────────────────────────────\nfunction deleteItem(id){\n  DATA=DATA.filter(d=>d.id!==id);\n  save(); render();\n}\n\n// ── AI CHAT ────────────────────────────────────────────────────────────\nasync function sendChat(){\n  const inp=document.getElementById(\'chatIn\');\n  const msg=inp.value.trim();\n  if(!msg) return;\n  inp.value=\'\'; inp.style.height=\'auto\';\n  appendMsg(\'user\',msg);\n  appendMsg(\'ai\',\'Thinking…\',true);\n  const snapshot=DATA.slice(0,80).map(d=>`[${d.type.toUpperCase()}] ${d.category} ${d.bhk} | ${d.locality} ${d.subLocality} | ${d.size||\'\'}${d.unit} | ${fmtBudget(d.budgetMin,d.budgetMax)} | ${d.contact}`).join(\'\\n\');\n  try{\n    const res=await fetch(\'https://api.anthropic.com/v1/messages\',{\n      method:\'POST\', headers:{\'Content-Type\':\'application/json\'},\n      body:JSON.stringify({\n        model:\'claude-sonnet-4-6\', max_tokens:900,\n        system:`You are PlotMatch AI for a real-estate dealer in Faridabad, Haryana, India.\nDatabase (${DATA.length} entries):\n${snapshot}\nConversions: 1 marla=30.25 sq.yd, 1 kanal=605 sq.yd, 1 gaj=1 sq.yd=9 sq.ft, 1 acre=4840 sq.yd\nReply in same language as user (Hindi/English/Hinglish). Be concise. Use ₹ for money.`,\n        messages:[{role:\'user\',content:msg}]\n      })\n    });\n    const d=await res.json();\n    replaceLastAi((d.content||[]).map(b=>b.text||\'\').join(\'\').trim());\n  }catch(e){ replaceLastAi(\'⚠️ \'+e.message); }\n}\n\nfunction appendMsg(role,text,thinking=false){\n  const box=document.getElementById(\'chatMsgs\');\n  const d=document.createElement(\'div\');\n  d.className=\'msg \'+role+(thinking?\' thinking\':\'\');\n  d.innerHTML=text.replace(/\\n/g,\'<br>\');\n  box.appendChild(d);\n  box.scrollTop=box.scrollHeight;\n}\nfunction replaceLastAi(text){\n  const box=document.getElementById(\'chatMsgs\');\n  const all=box.querySelectorAll(\'.msg.ai\');\n  const last=all[all.length-1];\n  if(last){last.classList.remove(\'thinking\');last.innerHTML=text.replace(/\\n/g,\'<br>\');}\n  box.scrollTop=box.scrollHeight;\n}\n\n// ── RENDER ─────────────────────────────────────────────────────────────\nfunction render(){\n  const q=document.getElementById(\'search\').value.toLowerCase();\n  const ft=document.getElementById(\'ftType\').value;\n  let list=DATA.filter(d=>{\n    if(ft&&d.type!==ft) return false;\n    if(!q) return true;\n    return [d.locality,d.subLocality,d.contact,d.notes,d.category,d.bhk].join(\' \').toLowerCase().includes(q);\n  });\n\n  // Stats\n  const c={buy:0,sell:0,rent_want:0,rent_have:0};\n  DATA.forEach(d=>{ if(c[d.type]!==undefined) c[d.type]++; });\n  document.getElementById(\'statsRow\').innerHTML=`\n    <div class="stat-chip"><div class="stat-n">${DATA.length}</div><div class="stat-l">Total</div></div>\n    <div class="stat-chip"><div class="stat-n" style="color:var(--buy)">${c.buy}</div><div class="stat-l">Buyers</div></div>\n    <div class="stat-chip"><div class="stat-n" style="color:var(--sell)">${c.sell}</div><div class="stat-l">Sellers</div></div>\n    <div class="stat-chip"><div class="stat-n" style="color:var(--rw)">${c.rent_want}</div><div class="stat-l">Rent Want</div></div>\n    <div class="stat-chip"><div class="stat-n" style="color:var(--rh)">${c.rent_have}</div><div class="stat-l">Rent Have</div></div>`;\n\n  if(!list.length){\n    document.getElementById(\'listBox\').innerHTML=`<div class="empty"><div class="empty-ico">🏘️</div><div class="empty-msg">No entries yet.<br>Paste a WhatsApp message<br>or add manually.</div></div>`;\n    return;\n  }\n\n  document.getElementById(\'listBox\').innerHTML=list.map(item=>{\n    const matches=getMatches(item);\n    const hasDup=DATA.some(d=>d.id!==item.id&&isDup(item,d));\n    const matchRows=matches.length?matches.map((m,i)=>`\n      <div class="match-row">\n        <div class="match-info">\n          <b>${m.d.category||\'\'} ${m.d.bhk||\'\'}</b> in ${m.d.locality||\'—\'} · ${fmtBudget(m.d.budgetMin,m.d.budgetMax)||\'—\'}<br>\n          📞 ${m.d.contact||\'—\'} ${m.d.groupName?`<span style="font-size:9px;background:#F0E6FF;color:#6B21A8;border-radius:10px;padding:1px 5px;font-weight:700;">📢 ${m.d.groupName.slice(0,18)}</span>`:\'\'}<br>\n          <span style="font-size:11px;font-weight:700;color:${freshnessColor(m.d.createdAt)};">${freshnessLabel(m.d.createdAt)} · ${fmtDT(m.d.createdAt)}</span>\n          ${m.why&&m.why.length?`<div class="match-why">${m.why.join(\' · \')}</div>`:\'\'}\n        </div>\n        <div class="score" style="background:${scoreColor(m.score)}">${m.score}%</div>\n      </div>`).join(\'\')\n    :\'<div style="color:var(--muted);font-size:13px;padding:6px 0;">No matches yet.</div>\';\n\n    return `<div class="req-card ${item.type} ${hasDup?\'is-dup\':\'\'}">\n      <div class="req-top">\n        <div class="req-info">\n          <div>\n            <span class="tag ${item.type}">${typeLabel(item.type)}</span>\n            ${item.source===\'whatsapp\'||item.source===\'whatsapp-paste\'||item.source===\'whatsapp-group\'?\'<span class="wa-tag">📱 WA</span>\':\'\'}\n            ${hasDup?\'<span class="dup-tag">⚠️ Dup</span>\':\'\'}\n          </div>\n          <div class="req-title">${item.category||\'Property\'}${item.bhk?\' · \'+item.bhk:\'\'} — ${item.locality||\'n/a\'}${item.subLocality?\' (\'+item.subLocality+\')\':\'\'}</div>\n          <div class="req-meta">\n            ${item.size?item.size+\' \'+item.unit+\' · \':\'\'}\n            ${fmtBudget(item.budgetMin,item.budgetMax)||\'Budget n/a\'}\n            ${item.facing?\' · \'+item.facing:\'\'}\n          </div>\n          ${item.contact?`<div class="req-meta">📞 ${item.contact}</div>`:\'\'}\n          ${item.notes?`<div class="req-notes">📝 ${item.notes}</div>`:\'\'}\n          <div class="req-time">📅 ${fmtDT(item.createdAt)} · ${ago(item.createdAt)}</div>\n        </div>\n        <button class="del-btn" onclick="deleteItem(\'${item.id}\')">✕</button>\n      </div>\n      <div class="match-section">\n        <div class="match-toggle" onclick="toggleMatch(this)">\n          Matches (${matches.length}) <span>›</span>\n        </div>\n        <div class="match-body">${matchRows}</div>\n      </div>\n    </div>`;\n  }).join(\'\');\n}\n\nfunction toggleMatch(el){\n  const body=el.nextElementSibling;\n  const open=body.classList.toggle(\'open\');\n  el.querySelector(\'span\').textContent=open?\'⌄\':\'›\';\n}\n\n// ── INSTALL PROMPT ─────────────────────────────────────────────────────\nfunction checkInstall(){\n  const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);\n  const isStandalone=window.navigator.standalone===true;\n  if(isIOS&&!isStandalone){\n    document.getElementById(\'installBanner\').style.display=\'flex\';\n  }\n}\n\n// ── INIT ───────────────────────────────────────────────────────────────\nDATA=load();\nrender();\nsetStatus(false,\'Local · \'+DATA.length+\' entries\');\ncheckInstall();\nconnect();\n</script>\n</body>\n</html>\n');
});

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

// Stats endpoint - shows per group message counts
app.get('/stats', (_, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const stats = {
    totalProcessed: processedCount,
    totalSkipped: skippedCount,
    groups: Object.entries(groupStats).map(([name, s]) => ({
      group: name,
      received: s.received,
      parsed: s.parsed,
      skipped: s.skipped,
      parseRate: s.received > 0 ? Math.round((s.parsed/s.received)*100)+'%' : '0%'
    })).sort((a,b) => b.received - a.received)
  };
  res.json(stats);
});

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
  'All Properties Neharpar',
  'AMAN PROPERTY',
  'SEC 81 FBD BROKERS 📍'
];

// Groups that are rent-focused (helps AI classify correctly)
const RENT_GROUPS = [];

function isAllowedGroup(chatName) {
  if (!chatName) return false;
  // Exact match
  if (ALLOWED_GROUPS.includes(chatName)) return true;
  // Strip ALL non-alphanumeric (emojis, spaces, punctuation) and compare
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normChat = norm(chatName);
  if (ALLOWED_GROUPS.some(g => norm(g) === normChat)) return true;
  // Partial match — if chat name CONTAINS any allowed group keyword
  const keywords = ['neharpar','aman property','sec 81','fbd brokers'];
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
    const postedAt = msg.timestamp ? msg.timestamp * 1000 : Date.now();

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

    // Track group stats
    groupStats[chatName] = groupStats[chatName] || { received: 0, parsed: 0, skipped: 0, duplicates: 0 };
    groupStats[chatName].received++;

    // Pre-filter: skip Claude API if no property keywords
    if (!hasPropertyKeywords(msgBody)) {
      groupStats[chatName].skipped++;
      skippedCount++;
      console.log(`[Whapi] ⏭️ SKIPPED (no keywords): "${msgBody.slice(0,60)}"`);
      continue;
    }

    // Check if this is a rent-focused group — hint to AI
    const isRentGroup = RENT_GROUPS.some(g => g === chatName || chatName.toLowerCase().includes('rent'));
    const rentHint = isRentGroup ? '\n\nNOTE: This message is from a RENT group. If intent is unclear, classify as rent_want or rent_have.' : '';

    try {
      const listings = await parseWithClaude(msgBody + rentHint);
      if (!listings || !listings.length) continue;
      console.log(`[Whapi] Parsed ${listings.length} listing(s) from "${chatName}"`);
      if (groupStats[chatName]) groupStats[chatName].parsed += listings.length;

      inbox.push({
        id: 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        listings,
        rawText: msgBody,
        from: from.replace('@s.whatsapp.net','').replace('@g.us',''),
        name: name,
        source: 'whatsapp-group',
        chatName,
        groupName: chatName,
        receivedAt: Date.now(),
        postedAt: postedAt
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
