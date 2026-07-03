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
 
app.get('/', (_, res) => res.send('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>PlotMatch — Faridabad</title>\n<style>\n:root{\n  --bg:#F6F1E7;--ink:#241F1B;--terra:#B5562F;--terra-dark:#8C4124;\n  --green:#2F5233;--gold:#C9A227;--line:#DCD2BE;--card:#FFFFFF;--muted:#7A7064;\n  font-family:"Helvetica Neue",Arial,sans-serif;\n}\n*{box-sizing:border-box;margin:0;padding:0;}\nbody{background:var(--bg);color:var(--ink);min-height:100vh;}\n.topbar{background:var(--ink);color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}\n.brand{display:flex;align-items:center;gap:10px;}\n.brand .logo{background:var(--terra);font-weight:900;font-size:13px;letter-spacing:.1em;padding:5px 9px;border-radius:4px;}\n.brand h1{font-size:20px;font-weight:700;letter-spacing:.02em;}\n.topbar-right{display:flex;align-items:center;gap:12px;font-size:13px;color:#ccc;}\n.server-url{font-size:11px;background:#333;border-radius:5px;padding:4px 10px;display:flex;align-items:center;gap:6px;}\n.server-url input{background:none;border:none;color:#fff;font-size:11px;width:260px;outline:none;}\n.server-url button{background:var(--terra);color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;font-weight:700;}\n.dot{width:8px;height:8px;border-radius:50%;background:#555;flex-shrink:0;}\n.dot.online{background:#4caf50;box-shadow:0 0 6px #4caf50;}\n\n.layout{display:grid;grid-template-columns:360px 1fr;min-height:calc(100vh - 52px);}\n@media(max-width:860px){.layout{grid-template-columns:1fr;}}\n\n/* LEFT PANEL */\n.left{padding:20px;border-right:1px solid var(--line);overflow-y:auto;max-height:calc(100vh - 52px);}\n.section-title{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--terra-dark);margin-bottom:10px;}\n.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px;}\n\ntextarea{width:100%;min-height:90px;border:1px solid var(--line);border-radius:7px;padding:9px;font-size:13px;resize:vertical;background:#FCFAF5;font-family:inherit;}\ntextarea:focus,input:focus,select:focus{outline:2px solid var(--gold);}\n\n.field{margin-bottom:9px;}\n.field label{display:block;font-size:10px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em;}\n.field input,.field select{width:100%;border:1px solid var(--line);border-radius:6px;padding:7px 9px;font-size:13px;background:#FCFAF5;}\n.two{display:grid;grid-template-columns:1fr 1fr;gap:8px;}\n\nbutton{font-family:inherit;font-weight:700;font-size:13px;border:none;border-radius:7px;padding:9px 14px;cursor:pointer;}\n.btn-primary{background:var(--terra);color:#fff;width:100%;margin-top:6px;}\n.btn-primary:hover{background:var(--terra-dark);}\n.btn-primary:disabled{opacity:.5;cursor:wait;}\n.btn-sm{background:transparent;border:1px solid var(--line);color:var(--ink);padding:5px 10px;font-size:12px;}\n.btn-sm:hover{border-color:var(--ink);}\n\n.parsed-box{background:#FBF3E8;border:1px dashed var(--gold);border-radius:8px;padding:10px;margin-top:10px;font-size:12.5px;line-height:1.7;}\n.parsed-box b{color:var(--terra-dark);}\n.parsed-box .actions{display:flex;gap:8px;margin-top:8px;}\n\n/* RIGHT PANEL */\n.right{padding:20px;overflow-y:auto;max-height:calc(100vh - 52px);}\n.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}\n.toolbar input{flex:1;min-width:160px;border:1px solid var(--line);border-radius:7px;padding:8px 10px;font-size:13px;background:var(--card);}\n.toolbar select{border:1px solid var(--line);border-radius:7px;padding:8px 10px;font-size:13px;background:var(--card);}\n.refresh-btn{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:8px 12px;font-size:18px;cursor:pointer;color:var(--muted);}\n.refresh-btn:hover{color:var(--ink);}\n\n/* MATCH ALERT */\n.alert-box{margin-bottom:16px;}\n.alert{border-radius:10px;padding:14px 16px;margin-bottom:10px;}\n.alert.match{background:#EAF2E9;border:2px solid var(--green);}\n.alert.saved{background:#FBF3E8;border:1px solid var(--gold);}\n.alert .a-title{font-weight:800;font-size:13px;margin-bottom:6px;}\n.alert.match .a-title{color:var(--green);}\n.alert.saved .a-title{color:var(--terra-dark);}\n.alert .a-body{font-size:12.5px;line-height:1.7;}\n.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;animation:pulse 1.2s infinite;}\n@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}\n\n/* CARDS */\n.req-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px;transition:border-color .2s;}\n.req-card:hover{border-color:var(--gold);}\n.req-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}\n.tag{font-weight:800;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:20px;color:#fff;white-space:nowrap;}\n.tag.buy{background:var(--terra);}\n.tag.sell{background:var(--green);}\n.tag.rent{background:var(--gold);color:var(--ink);}\n.req-title{font-size:16px;font-weight:700;margin:6px 0 2px;}\n.req-meta{font-size:12px;color:var(--muted);margin-top:2px;}\n.req-meta span{margin-right:10px;}\n.req-source{font-size:11px;color:var(--muted);margin-top:4px;font-style:italic;}\n.del-btn{background:none;border:none;cursor:pointer;font-size:13px;color:var(--muted);padding:2px 5px;border-radius:4px;}\n.del-btn:hover{color:var(--terra);}\n\n.match-panel{margin-top:10px;border-top:1px solid var(--line);padding-top:10px;}\n.match-panel summary{font-size:11px;font-weight:800;color:var(--terra-dark);cursor:pointer;letter-spacing:.04em;text-transform:uppercase;}\n.match-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #F0EAE0;font-size:12.5px;}\n.match-row:last-child{border:none;}\n.score{font-weight:800;font-size:10.5px;padding:2px 7px;border-radius:20px;color:#fff;white-space:nowrap;}\n\n.empty{text-align:center;padding:60px 20px;color:var(--muted);}\n.empty .ico{font-size:40px;margin-bottom:10px;}\n.stats{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;}\n.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;text-align:center;min-width:80px;}\n.stat .n{font-size:24px;font-weight:800;color:var(--terra);}\n.stat .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;}\n.spinning{animation:spin 1s linear infinite;display:inline-block;}\n@keyframes spin{to{transform:rotate(360deg);}}\n</style>\n</head>\n<body>\n\n<div class="topbar">\n  <div class="brand">\n    <div class="logo">PM</div>\n    <h1>PlotMatch <span style="font-weight:300;font-size:14px;opacity:.7;">Faridabad</span></h1>\n  </div>\n  <div class="topbar-right">\n    <div class="server-url">\n      <div class="dot" id="statusDot"></div>\n      <input id="serverUrl" value="https://plotmatch-server.onrender.com" placeholder="https://your-server.onrender.com">\n      <button onclick="connect()">Connect</button>\n    </div>\n    <span id="statusText" style="font-size:11px;">Not connected</span>\n  </div>\n</div>\n\n<div class="layout">\n\n  <!-- LEFT: Input panel -->\n  <div class="left">\n\n    <div class="card">\n      <div class="section-title">Paste WhatsApp Message</div>\n      <textarea id="rawInput" placeholder="Paste any WhatsApp message — single listing or multiple. AI will extract all properties automatically.&#10;&#10;e.g. Sector 21A me 250 gaj plot chahiye corner north facing 1.5 cr tak"></textarea>\n      <div style="display:flex;gap:8px;margin-top:8px;">\n        <button class="btn-primary" id="parseBtn" style="flex:1;" onclick="parseMessage()">Parse with AI →</button>\n        <button class="btn-sm" onclick="document.getElementById(\'rawInput\').value=\'\';document.getElementById(\'parsedBox\').innerHTML=\'\'">Clear</button>\n      </div>\n      <div id="parsedBox"></div>\n    </div>\n\n    <div class="card">\n      <div class="section-title">Add Manually</div>\n      <div class="field"><label>Type</label>\n        <select id="f_type"><option value="buy">Buy</option><option value="sell">Sell</option><option value="rent">Rent</option></select>\n      </div>\n      <div class="two">\n        <div class="field"><label>Category</label>\n          <select id="f_cat"><option>Plot</option><option>Floor</option><option>Flat</option><option>House</option><option>Shop</option><option>Office</option><option>Other</option></select>\n        </div>\n        <div class="field"><label>BHK / Floor</label><input id="f_bhk" placeholder="3BHK / 1st floor"></div>\n      </div>\n      <div class="field"><label>Locality / Sector *</label><input id="f_loc" placeholder="Sector 21A, Faridabad"></div>\n      <div class="two">\n        <div class="field"><label>Size</label><input id="f_size" placeholder="250" type="number"></div>\n        <div class="field"><label>Unit</label>\n          <select id="f_unit"><option>sq.yd</option><option>sq.ft</option><option>marla</option><option>kanal</option><option>acre</option></select>\n        </div>\n      </div>\n      <div class="two">\n        <div class="field"><label>Budget Min (₹)</label><input id="f_bmin" placeholder="e.g. 10000000"></div>\n        <div class="field"><label>Budget Max (₹)</label><input id="f_bmax" placeholder="e.g. 15000000"></div>\n      </div>\n      <div class="field"><label>Facing</label>\n        <select id="f_facing"><option value="">— Any —</option><option>North</option><option>South</option><option>East</option><option>West</option><option>North-East</option><option>North-West</option><option>South-East</option><option>South-West</option><option>Corner</option></select>\n      </div>\n      <div class="field"><label>Contact</label><input id="f_contact" placeholder="Sharma ji 98XXXXXXXX"></div>\n      <div class="field"><label>Notes</label><input id="f_notes" placeholder="File ready, registry clear, road width, etc."></div>\n      <button class="btn-primary" onclick="addManual()">Add to Database</button>\n    </div>\n\n  </div>\n\n  <!-- RIGHT: Listings -->\n  <div class="right">\n    <div id="alertBox"></div>\n    <div class="stats" id="statsRow"></div>\n    <div class="toolbar">\n      <input id="search" placeholder="Search locality, contact, notes…" oninput="render()">\n      <select id="ftType" onchange="render()"><option value="">All types</option><option value="buy">Buy</option><option value="sell">Sell</option><option value="rent">Rent</option></select>\n      <button class="refresh-btn" id="refreshBtn" onclick="loadData()" title="Refresh">↻</button>\n    </div>\n    <div id="listBox"></div>\n  </div>\n\n</div>\n\n<script>\nlet SERVER = \'https://plotmatch-server.onrender.com\';\nlet DATA = [];\n\n// ── Server connection ──────────────────────────────────────────────\nfunction connect(){\n  SERVER = document.getElementById(\'serverUrl\').value.trim().replace(/\\/$/, \'\');\n  loadData();\n}\n\nasync function loadData(){\n  const dot = document.getElementById(\'statusDot\');\n  const txt = document.getElementById(\'statusText\');\n  const btn = document.getElementById(\'refreshBtn\');\n  btn.innerHTML = \'<span class="spinning">↻</span>\';\n  try {\n    const res = await fetch(SERVER + \'/requirements\');\n    if(!res.ok) throw new Error(\'HTTP \' + res.status);\n    DATA = await res.json();\n    DATA.sort((a,b) => b.createdAt - a.createdAt);\n    dot.className = \'dot online\';\n    txt.textContent = \'Live · \' + DATA.length + \' entries\';\n    render();\n  } catch(e) {\n    dot.className = \'dot\';\n    txt.textContent = \'Offline — check URL\';\n    console.error(e);\n  } finally {\n    btn.innerHTML = \'↻\';\n  }\n}\n\n// ── Formatting ─────────────────────────────────────────────────────\nfunction fmtINR(n){\n  if(!n) return \'\';\n  if(n>=10000000) return \'₹\'+(n/10000000).toFixed(2).replace(/\\.?0+$/,\'\')+\' Cr\';\n  if(n>=100000)   return \'₹\'+(n/100000).toFixed(1).replace(/\\.?0+$/,\'\')+\' L\';\n  return \'₹\'+n.toLocaleString(\'en-IN\');\n}\nfunction fmtBudget(min,max){\n  if(min&&max) return fmtINR(min)+\' – \'+fmtINR(max);\n  if(max) return \'up to \'+fmtINR(max);\n  if(min) return fmtINR(min)+\'+\';\n  return \'\';\n}\nfunction timeAgo(ts){\n  const s = Math.floor((Date.now()-ts)/1000);\n  if(s<60) return \'just now\';\n  if(s<3600) return Math.floor(s/60)+\'m ago\';\n  if(s<86400) return Math.floor(s/3600)+\'h ago\';\n  return Math.floor(s/86400)+\'d ago\';\n}\n\n// ── Matching ────────────────────────────────────────────────────────\nfunction norm(s){ return (s||\'\').toLowerCase().replace(/[^a-z0-9]/g,\'\'); }\nfunction scoreMatch(a,b){\n  if(a.type===\'buy\'&&b.type!==\'sell\') return -1;\n  if(a.type===\'sell\'&&b.type!==\'buy\') return -1;\n  if(a.type===\'rent\'&&b.type!==\'rent\') return -1;\n  let sc=0;\n  const la=norm(a.locality),lb2=norm(b.locality);\n  if(la&&lb2){ if(la===lb2) sc+=40; else if(la.includes(lb2)||lb2.includes(la)) sc+=25; }\n  if(a.category&&b.category&&a.category===b.category) sc+=20;\n  const buyer=a.type===\'sell\'?b:a, seller=a.type===\'sell\'?a:b;\n  const bMax=buyer.budgetMax||buyer.budgetMin, sAsk=seller.budgetMax||seller.budgetMin;\n  if(bMax&&sAsk){ if(bMax>=sAsk*0.95) sc+=25; else sc+=Math.max(0,25*(1-(sAsk-bMax)/sAsk*2)); }\n  if(a.facing&&b.facing&&a.facing===b.facing) sc+=5;\n  if(a.bhk&&b.bhk&&a.bhk.toLowerCase()===b.bhk.toLowerCase()) sc+=10;\n  return Math.max(0,Math.min(100,Math.round(sc)));\n}\nfunction scoreColor(s){ return s>=70?\'#2F5233\':s>=40?\'#C9A227\':\'#7A7064\'; }\n\nfunction getMatches(item){\n  return DATA.filter(d=>d.id!==item.id)\n    .map(d=>({d, sc:scoreMatch(item,d)}))\n    .filter(m=>m.sc>0)\n    .sort((a,b)=>b.sc-a.sc)\n    .slice(0,5);\n}\n\n// ── Parse via AI ───────────────────────────────────────────────────\nasync function parseMessage(){\n  const raw = document.getElementById(\'rawInput\').value.trim();\n  if(!raw) return;\n  const btn = document.getElementById(\'parseBtn\');\n  btn.disabled = true; btn.textContent = \'AI is reading…\';\n  try {\n    const res = await fetch(\'https://api.anthropic.com/v1/messages\', {\n      method:\'POST\',\n      headers:{\'Content-Type\':\'application/json\'},\n      body: JSON.stringify({\n        model:\'claude-sonnet-4-6\', max_tokens:2000,\n        system:`You are a real-estate AI for Faridabad/NCR India. Extract ALL property listings from the message. Return ONLY a raw JSON array:\n[{"type":"buy|sell|rent","category":"Plot|Floor|Flat|House|Shop|Office|Other","bhk":"","locality":"","subLocality":"","size":null,"unit":"sq.yd|sq.ft|marla|kanal|acre","budgetMin":null,"budgetMax":null,"facing":"North|South|East|West|North-East|North-West|South-East|South-West|Corner|","contact":"","notes":""}]\nRules: 1 cr=10000000, 1 lac=100000. gaj=sq.yd. SF=sq.yd. "chahiye/required"=buy. "available/for sale"=sell. Always return array.`,\n        messages:[{role:\'user\',content:raw}]\n      })\n    });\n    const data = await res.json();\n    const txt = (data.content||[]).map(b=>b.text||\'\').join(\'\');\n    const listings = JSON.parse(txt.replace(/```json|```/g,\'\').trim());\n    const arr = Array.isArray(listings)?listings:[listings];\n    showParsed(arr, raw);\n  } catch(e){\n    document.getElementById(\'parsedBox\').innerHTML = `<div class="parsed-box">⚠️ Could not parse. Try simpler text or add manually.<br><small>${e.message}</small></div>`;\n  } finally {\n    btn.disabled=false; btn.textContent=\'Parse with AI →\';\n  }\n}\n\nfunction showParsed(listings, raw){\n  const html = listings.map((l,i)=>`\n    <div style="border-bottom:1px solid #EEE;padding:8px 0;">\n      <b>${l.type?.toUpperCase()} · ${l.category||\'Property\'} ${l.bhk||\'\'}</b><br>\n      ${l.locality||\'—\'} ${l.subLocality?\'(\'+l.subLocality+\')\':\'\'} · \n      ${l.size?l.size+\' \'+l.unit:\'\'} · ${l.facing||\'\'}<br>\n      Budget: ${fmtBudget(l.budgetMin,l.budgetMax)||\'—\'} · Contact: ${l.contact||\'—\'}<br>\n      ${l.notes?\'<em>\'+l.notes+\'</em>\':\'\'}\n    </div>`).join(\'\');\n  document.getElementById(\'parsedBox\').innerHTML = `\n    <div class="parsed-box">\n      <b>${listings.length} listing(s) found:</b>\n      ${html}\n      <div class="actions">\n        <button class="btn-primary" onclick="confirmAdd(${JSON.stringify(listings).replace(/"/g,\'&quot;\')}, ${JSON.stringify(raw).replace(/"/g,\'&quot;\')})">Add all to database</button>\n        <button class="btn-sm" onclick="document.getElementById(\'parsedBox\').innerHTML=\'\'">Discard</button>\n      </div>\n    </div>`;\n}\n\nasync function confirmAdd(listings, raw){\n  for(const l of listings){\n    await postToServer({...l, rawText: raw});\n  }\n  document.getElementById(\'parsedBox\').innerHTML = \'\';\n  document.getElementById(\'rawInput\').value = \'\';\n  await loadData();\n}\n\n// ── Post to server ─────────────────────────────────────────────────\nasync function postToServer(item){\n  const res = await fetch(SERVER + \'/add\', {\n    method:\'POST\',\n    headers:{\'Content-Type\':\'application/json\'},\n    body: JSON.stringify(item)\n  });\n  const data = await res.json();\n  if(data.matches && data.matches.length > 0){\n    showAlert(data.matches, data.item);\n  }\n  return data;\n}\n\nfunction showAlert(matches, newItem){\n  const html = matches.map(m=>`\n    <div class="alert match">\n      <div class="a-title"><span class="pulse"></span>MUTUAL MATCH IDENTIFIED!</div>\n      <div class="a-body">\n        <b>Buyer:</b> ${m.buyer.contact||m.buyer.id} — ${m.buyer.category||\'\'} ${m.buyer.bhk||\'\'} in ${m.buyer.locality||\'—\'} · ${fmtBudget(m.buyer.budgetMin,m.buyer.budgetMax)}<br>\n        <b>Seller:</b> ${m.seller.contact||m.seller.id} — ${m.seller.category||\'\'} ${m.seller.bhk||\'\'} in ${m.seller.locality||\'—\'} · ${fmtBudget(m.seller.budgetMin,m.seller.budgetMax)}<br>\n        <b>Why:</b> Locality &amp; budget align perfectly.\n      </div>\n    </div>`).join(\'\');\n  document.getElementById(\'alertBox\').innerHTML = html;\n  setTimeout(()=>document.getElementById(\'alertBox\').innerHTML=\'\', 30000);\n}\n\n// ── Manual add ─────────────────────────────────────────────────────\nasync function addManual(){\n  const loc = document.getElementById(\'f_loc\').value.trim();\n  if(!loc){ document.getElementById(\'f_loc\').focus(); return; }\n  await postToServer({\n    type: document.getElementById(\'f_type\').value,\n    category: document.getElementById(\'f_cat\').value,\n    bhk: document.getElementById(\'f_bhk\').value.trim(),\n    locality: loc,\n    size: parseFloat(document.getElementById(\'f_size\').value)||null,\n    unit: document.getElementById(\'f_unit\').value,\n    budgetMin: parseFloat(document.getElementById(\'f_bmin\').value.replace(/,/g,\'\'))||null,\n    budgetMax: parseFloat(document.getElementById(\'f_bmax\').value.replace(/,/g,\'\'))||null,\n    facing: document.getElementById(\'f_facing\').value,\n    contact: document.getElementById(\'f_contact\').value.trim(),\n    notes: document.getElementById(\'f_notes\').value.trim(),\n    rawText:\'\'\n  });\n  [\'f_bhk\',\'f_loc\',\'f_size\',\'f_bmin\',\'f_bmax\',\'f_contact\',\'f_notes\'].forEach(id=>document.getElementById(id).value=\'\');\n  await loadData();\n}\n\n// ── Render listings ────────────────────────────────────────────────\nfunction render(){\n  const q = document.getElementById(\'search\').value.toLowerCase();\n  const ft = document.getElementById(\'ftType\').value;\n  let list = DATA.filter(d=>{\n    if(ft&&d.type!==ft) return false;\n    if(!q) return true;\n    return [d.locality,d.contact,d.notes,d.category,d.bhk,d.subLocality].join(\' \').toLowerCase().includes(q);\n  });\n\n  // Stats\n  const buys=DATA.filter(d=>d.type===\'buy\').length;\n  const sells=DATA.filter(d=>d.type===\'sell\').length;\n  const rents=DATA.filter(d=>d.type===\'rent\').length;\n  document.getElementById(\'statsRow\').innerHTML = `\n    <div class="stat"><div class="n">${DATA.length}</div><div class="l">Total</div></div>\n    <div class="stat"><div class="n" style="color:var(--terra)">${buys}</div><div class="l">Buyers</div></div>\n    <div class="stat"><div class="n" style="color:var(--green)">${sells}</div><div class="l">Sellers</div></div>\n    <div class="stat"><div class="n" style="color:var(--gold)">${rents}</div><div class="l">Rent</div></div>`;\n\n  if(!list.length){\n    document.getElementById(\'listBox\').innerHTML = `<div class="empty"><div class="ico">🗺️</div>No requirements yet.<br>Paste a WhatsApp message or add manually.</div>`;\n    return;\n  }\n\n  document.getElementById(\'listBox\').innerHTML = list.map(item=>{\n    const matches = getMatches(item);\n    const matchHtml = matches.length ? matches.map(m=>`\n      <div class="match-row">\n        <span>\n          <span class="tag ${m.d.type}" style="font-size:9px;padding:1px 6px;">${m.d.type}</span>\n          ${m.d.category||\'\'} ${m.d.bhk?\'· \'+m.d.bhk:\'\'} · ${m.d.locality||\'—\'} \n          ${m.d.size?\'· \'+m.d.size+\' \'+m.d.unit:\'\'} · ${fmtBudget(m.d.budgetMin,m.d.budgetMax)||\'—\'}\n          ${m.d.contact?\' · \'+m.d.contact:\'\'}\n        </span>\n        <span class="score" style="background:${scoreColor(m.sc)}">${m.sc}%</span>\n      </div>`).join(\'\') : `<div style="color:var(--muted);font-size:12px;padding:6px 0;">No matches yet</div>`;\n\n    return `<div class="req-card">\n      <div class="req-top">\n        <div style="flex:1;">\n          <span class="tag ${item.type}">${item.type}</span>\n          <div class="req-title">${item.category||\'Property\'} ${item.bhk?\'· \'+item.bhk:\'\'} — ${item.locality||\'Locality n/a\'} ${item.subLocality?\'(\'+item.subLocality+\')\':\'\'}</div>\n          <div class="req-meta">\n            <span>${item.size?item.size+\' \'+item.unit:\'Size n/a\'}</span>\n            <span>${fmtBudget(item.budgetMin,item.budgetMax)||\'Budget n/a\'}</span>\n            ${item.facing?`<span>${item.facing} facing</span>`:\'\'}\n            ${item.contact?`<span>📞 ${item.contact}</span>`:\'\'}\n          </div>\n          ${item.notes?`<div class="req-meta" style="margin-top:4px;font-style:italic;">${item.notes}</div>`:\'\'}\n          <div class="req-source">${item.source&&item.source!==\'dashboard\'?\'via WhatsApp · \':\'\'} ${timeAgo(item.createdAt)}</div>\n        </div>\n        <button class="del-btn" title="Delete" onclick="deleteItem(\'${item.id}\')">✕</button>\n      </div>\n      <details class="match-panel">\n        <summary>Closest matches (${matches.length})</summary>\n        ${matchHtml}\n      </details>\n    </div>`;\n  }).join(\'\');\n}\n\nasync function deleteItem(id){\n  DATA = DATA.filter(d=>d.id!==id);\n  render();\n  // Note: deletion from server not yet implemented — refreshing will restore\n  // You can add DELETE /requirements/:id to server for full delete support\n}\n\n// ── Auto refresh every 30s ─────────────────────────────────────────\nloadData();\nsetInterval(loadData, 30000);\n</script>\n</body>\n</html>\n'));
 
app.get('/requirements', (_, res) => {
  res.header('Access-Control-Allow-Origin', '*'); res.json(readDB().requirements);
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
 
 
// ── Manual add from dashboard ─────────────────────────────────────────
app.post('/add', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const body = req.body;
    const item = {
      id: uid(),
      type: body.type || 'buy',
      category: body.category || '',
      bhk: body.bhk || '',
      locality: body.locality || '',
      subLocality: body.subLocality || '',
      size: parseFloat(body.size) || null,
      unit: body.unit || '',
      budgetMin: parseFloat(body.budgetMin) || null,
      budgetMax: parseFloat(body.budgetMax) || null,
      facing: body.facing || '',
      contact: body.contact || '',
      notes: body.notes || '',
      rawText: body.rawText || '',
      source: 'dashboard',
      createdAt: Date.now()
    };
    const data = readDB();
    const hits = findMatches(item, data.requirements);
    data.requirements.unshift(item);
    writeDB(data);
    res.json({ success: true, item, matches: hits });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
 
app.options('/add', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.send();
});
 
app.options('/requirements', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.send();
});
 
app.listen(PORT, () => {
  console.log(`\n✅ PlotMatch server running on port ${PORT}`);
  console.log(`   ANTHROPIC_API_KEY : ${ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_AUTH_TOKEN : ${TWILIO_AUTH_TOKEN ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   TWILIO_WA_FROM    : ${TWILIO_WHATSAPP_FROM || 'MISSING ✗'}\n`);
});
 
// This line intentionally left blank - POST /add endpoint added below via patch
 
