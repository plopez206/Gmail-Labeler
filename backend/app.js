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
const SCOPES         = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_ENV_KEY = 'GOOGLE_CREDENTIALS_JSON';
const REDIRECT_URI   = process.env.REDIRECT_URI;   // e.g. https://your-backend.onrender.com/auth/callback
const FRONTEND_URL   = process.env.FRONTEND_URL;   // e.g. https://your-frontend.netlify.app

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Express setup
const app = express();
app.set('trust proxy', 1);
app.use(cors({
    origin: FRONTEND_URL,   // e.g. https://taupe-manatee-499615.netlify.app
    credentials: true
  }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',  // on HTTPS only
      sameSite: 'none',                               // allow cross‑site
      maxAge: 24 * 60 * 60 * 1000                     // e.g. 1 day
    }
  }));
  
// Health check (for Render)
app.get('/health', (req, res) => res.send('OK'));

// Status endpoint: is this browser session connected?
app.get('/status', (req, res) => {
  res.json({ connected: !!req.session.tokens });
});

// Create OAuth2 client using either env JSON or file
function getOAuth2Client() {
  let raw = process.env[ CREDENTIALS_ENV_KEY ];
  if (!raw) {
    // fallback to credentials.json on disk
    raw = fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8');
  }
  const creds = JSON.parse(raw);
  const conf  = creds.web || creds.installed;
  if (!conf) {
    console.error("Missing 'web' or 'installed' in credentials JSON");
    process.exit(1);
  }
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

// BEGIN OAuth routes

// 1) Redirect to Google's consent screen
app.get('/auth', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

// 2) OAuth callback: exchange code -> tokens in session
app.get('/auth/callback', async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    req.session.tokens = tokens;        // store tokens in THIS session
    client.setCredentials(tokens);

    // Auto-subscribe into a simple file-based whitelist (optional)
    // e.g. you could still keep a global whitelist.json if desired

    // Redirect back to frontend with flag
    return res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).send('Authentication error');
  }
});

// END OAuth routes

// Helper: build Gmail client from session tokens
function getGmailClientFromSession(req) {
  if (!req.session.tokens) {
    throw new Error('Not authenticated in this session');
  }
  const client = getOAuth2Client();
  client.setCredentials(req.session.tokens);
  return google.gmail({ version: 'v1', auth: client });
}

// Use OpenAI to classify an email
async function classifyEmail(subject, snippet) {
  const system = {
    role: 'system',
    content:
      "You are an email classifier. Choose exactly one category (emoji included) from this list:\n" +
      "arduino\nCopy\nEdit\n✅ Action Required\n🕒 Follow Up\n🤝 Client\n📌 Important\n" +
      "🧾 Receipts\n📣 Marketing\n🗑️ Spam / Ignore\n📂 Archived"
  };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };
  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [system, user],
    temperature: 0
  });
  return resp.choices[0].message.content.trim();
}

// Ensure Gmail label exists or create it (handling 409)
async function getOrCreateLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  let existing = list.data.labels.find(l => l.name === name);
  if (existing) return existing.id;

  try {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
    return created.data.id;
  } catch (e) {
    if (e.response && e.response.status === 409) {
      const fresh = await gmail.users.labels.list({ userId: 'me' });
      existing = fresh.data.labels.find(l => l.name === name);
      if (existing) return existing.id;
    }
    throw e;
  }
}

// Core processing: fetch up to 5 unread in INBOX, classify & label, keep them unread
async function processJob(req) {
  const gmail = getGmailClientFromSession(req);

  // list unread in INBOX
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    q: 'is:unread',
    maxResults: 5
  });
  const messages = listRes.data.messages || [];
  const summary = [];

  for (const m of messages) {
    const msgRes = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = msgRes.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const snippet = msgRes.data.snippet;

    const labelName = await classifyEmail(subject, snippet);
    const labelId   = await getOrCreateLabel(gmail, labelName);

    await gmail.users.messages.modify({
      userId: 'me',
      id: m.id,
      requestBody: {
        addLabelIds:    [labelId, 'UNREAD'],
        removeLabelIds: []
      }
    });

    summary.push({ subject, label: labelName });
  }

  return summary;
}

// Schedule twice daily
cron.schedule('0 7 * * *', () => { /* cannot access req, skip scheduled for per-user */ });
cron.schedule('0 15 * * *', () => { /* same */ });
console.log('Scheduler is set (manual only, scheduled runs skip sessions)');

// Manual /run-now: only works in authenticated session
app.get('/run-now', async (req, res) => {
    console.log('SESSION TOKENS:', req.session.tokens);
    if (!req.session.tokens) {
      console.log('→ No tokens in this session');
      return res.status(401).json({ status:'error', message:'Not authenticated in this session' });
    }
  try {
    const results = await processJob(req);
    return res.json({ status: 'ok', results });
  } catch (err) {
    console.error('Run‑now error:', err);
    return res.status(401).json({ status: 'error', message: err.message });
  }
});

// Redirect root to frontend
app.get('/', (req, res) => {
  res.redirect(FRONTEND_URL || '/');
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend listening on 0.0.0.0:${PORT}`);
});
