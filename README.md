# PlotMatch Webhook Server — Deploy to Render

This server receives WhatsApp messages forwarded to your Twilio number, parses
them with Claude into structured property requirements, runs the matchmaking
engine against everything already saved, and replies to you on WhatsApp.

You do **not** need Node.js installed on your computer — Render builds and
runs it in the cloud. You only need a GitHub account and a Render account
(both free).

## Step 1 — Put this code on GitHub

1. Go to https://github.com and create a free account if you don't have one.
2. Click the "+" in the top right → **New repository**. Name it `plotmatch-server`,
   keep it Private, click **Create repository**.
3. On the new repo's page, click **uploading an existing file**.
4. Drag in all the files from this folder (`server.js`, `package.json`,
   `.env.example`, this `README.md`) and click **Commit changes**.

## Step 2 — Create the service on Render

1. Go to https://render.com and sign up free (you can sign up with your GitHub
   account directly — it's the easiest option).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account if prompted, then select the `plotmatch-server`
   repo you just created.
4. Fill in:
   - **Name**: `plotmatch-server` (or anything you like)
   - **Region**: pick the one closest to India (e.g. Singapore) if offered
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Scroll to **Environment Variables** and add these one by one (values from
   `.env.example` — fill in your real keys):
   - `ANTHROPIC_API_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_WHATSAPP_FROM` (use `whatsapp:+14155238886` for the Sandbox)
6. Click **Create Web Service**. Render will install and start the app —
   takes 1–3 minutes. When it's done you'll see a URL like:
   `https://plotmatch-server-xxxx.onrender.com`

## Step 3 — Where to find your Twilio keys

- **Account SID** and **Auth Token**: Twilio Console homepage, top right
  "Account Info" box.
- **Sandbox WhatsApp number**: Messaging → Try it out → Send a WhatsApp
  message. It's the same number you already joined for Emergent AI
  (e.g. `+1 415 523 8886`).

## Step 4 — Point Twilio at your new server

1. In Twilio Console: Messaging → Try it out → Send a WhatsApp message →
   **Sandbox Settings**.
2. In the **"When a message comes in"** field, paste:
   `https://plotmatch-server-xxxx.onrender.com/webhook`
   (use your actual Render URL, with `/webhook` at the end)
3. Method: **HTTP POST**. Click **Save**.

## Step 5 — Test it

Send a WhatsApp message to your sandbox number, something like:

> Sector 21A me 250 gaj ka plot chahiye, corner, north facing, budget 1.5 cr tak

You should get a WhatsApp reply within a few seconds confirming it was saved,
or a MUTUAL MATCH alert if it matches something already stored. You can also
check everything saved so far by visiting:
`https://plotmatch-server-xxxx.onrender.com/requirements` in your browser.

## Notes

- The free Render tier "sleeps" after 15 minutes of no traffic and takes
  ~30–60 seconds to wake up on the next message — fine for testing, but if
  this becomes your daily tool, consider their $7/mo plan so it stays warm.
- Data is stored in a file (`db.json`) on the server. On Render's free tier
  this resets on redeploys — good enough for testing, but before going fully
  live we should move this to a proper database (e.g. Supabase) so nothing
  is ever lost.
