// backend/app.js
// Node.js Gmail automation backend using Express, Google OAuth, and OpenAI

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const { google } = require('googleapis');
const OpenAI = require('openai').default;
const cron   = require('node-cron');

// Configuration
const SCOPES           = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH       = path.join(__dirname, 'token.json');
const WHITELIST_PATH   = path.join(__dirname, 'whitelist.json');
const REDIRECT_URI     = process.env.REDIRECT_URI;       // Must match Google OAuth settings
const FRONTEND_URL     = process.env.FRONTEND_URL;       // Your frontend URL

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Express setup
const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Health check
app.get('/health', (req, res) => res.send('OK'));

// Status endpoint
app.get('/status', (req, res) => {
  res.json({ connected: fs.existsSync(TOKEN_PATH) });
});

// Whitelist functions
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}
function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

// Create OAuth2 client
function getOAuth2Client() {
  let raw;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    raw = process.env.GOOGLE_CREDENTIALS_JSON;
  } else {
    raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  }
  const creds = JSON.parse(raw);
  const conf  = creds.web || creds.installed;
  if (!conf) {
    console.error("Missing 'web' or 'installed' in credentials.json");
    process.exit(1);
  }
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

// OAuth routes
app.get('/auth', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

    // Auto-subscribe
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const wl = loadWhitelist();
    if (!wl.includes(email)) {
      wl.push(email);
      saveWhitelist(wl);
    }

    // Redirect to frontend
    res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('Authentication error');
  }
});

// Get Gmail service
async function getGmailService() {
  const client = getOAuth2Client();
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Not authenticated');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: client });
}

// Classify
async function classifyEmail(subject, snippet) {
  const system = { role: 'system', content: /* prompt */
    "You are an email classifier. Choose one category (emoji included): Arduino, Copy, Edit, ✅ Action Required, 🕒 Follow Up, 🤝 Client, 📌 Important, 🧾 Receipts, 📣 Marketing, 🗑️ Spam / Ignore, 📂 Archived"
  };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };
  const resp = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [system, user], temperature: 0 });
  return resp.choices[0].message.content.trim();
}

// Ensure label exists
async function getOrCreateLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  let lbl = data.labels.find(l => l.name === name);
  if (lbl) return lbl.id;
  try {
    const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    return created.data.id;
  } catch (e) {
    if (e.response && e.response.status === 409) {
      const { data: fresh } = await gmail.users.labels.list({ userId: 'me' });
      lbl = fresh.labels.find(l => l.name === name);
      if (lbl) return lbl.id;
    }
    throw e;
  }
}

// Process job
async function processJob() {
  try {
    const gmail = await getGmailService();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const wl = loadWhitelist();
    if (wl.length && !wl.includes(email)) return [];

    const res = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 5 });
    console.log('Gmail response:', res.data);
    const msgs = res.data.messages || [];
    const out = [];
    for (const m of msgs) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const hdrs = msg.data.payload.headers;
      const subj = hdrs.find(h=>h.name==='Subject')?.value || '(no subject)';
      const snip = msg.data.snippet;
      const labelName = await classifyEmail(subj, snip);
      const lid = await getOrCreateLabel(gmail, labelName);
      await gmail.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [lid, 'UNREAD'], removeLabelIds: [] } });
      out.push({ subject: subj, label: labelName });
    }
    return out;
  } catch (err) {
    console.error('Error in processJob:', err);
    return [];
  }
}

// Cron
cron.schedule('0 7 * * *', () => processJob());
cron.schedule('0 15 * * *',() => processJob());
console.log('Scheduler set');

// Endpoints
app.get('/run-now', async (req, res) => res.json({ status:'ok', results: await processJob() }));
app.get('/whitelist', (req,res) => res.json({ whitelist: loadWhitelist() }));
app.get('/', (req,res) => res.redirect(FRONTEND_URL || '/'));

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', ()=> console.log(`Listening on ${PORT}`));
