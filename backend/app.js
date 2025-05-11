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
const REDIRECT_URI     = process.env.REDIRECT_URI;         // e.g. https://your-backend.onrender.com/auth/callback
const FRONTEND_URL     = process.env.FRONTEND_URL;         // e.g. https://your-frontend.netlify.app

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

// Load or initialize whitelist
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}
function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

// OAuth2 client factory supporting both web and installed creds
function getOAuth2Client() {
  // Load credentials JSON from env var or disk
  let raw;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    raw = process.env.GOOGLE_CREDENTIALS_JSON;
  } else {
    raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  }

  const creds = JSON.parse(raw);
  const conf  = creds.web || creds.installed;
  if (!conf) {
    console.error("credentials.json must contain 'web' or 'installed'");
    process.exit(1);
  }

  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

// STATUS endpoint: tells frontend if we're already authenticated
app.get('/status', (req, res) => {
  const connected = fs.existsSync(TOKEN_PATH);
  res.json({ connected });
});

// Start OAuth flow
app.get('/auth', (req, res) => {
  const oAuth2Client = getOAuth2Client();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// OAuth callback: exchange code, store tokens, update whitelist, then redirect to frontend
app.get('/auth/callback', async (req, res) => {
  try {
    const oAuth2Client = getOAuth2Client();
    const { code }     = req.query;
    const { tokens }   = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Persist the token for later use
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

    // Auto‑subscribe the user
    const gmail   = google.gmail({ version: 'v1', auth: oAuth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email   = profile.data.emailAddress;
    const whitelist = loadWhitelist();
    if (!whitelist.includes(email)) {
      whitelist.push(email);
      saveWhitelist(whitelist);
    }

    // Redirect back to your React app with a flag
    return res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('Error in /auth/callback:', err);
    return res.status(500).send('Authentication error');
  }
});

// Helper to get an authorized Gmail client
async function getGmailService() {
  const oAuth2Client = getOAuth2Client();
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Not authenticated. Visit /auth first.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// Use OpenAI to classify an email
async function classifyEmail(subject, snippet) {
  const system = {
    role:    'system',
    content: "You are an email classifier. Choose exactly one category (emoji included) from this list:\n" +
             "arduino\nCopy\nEdit\n✅ Action Required\n🕒 Follow Up\n🤝 Client\n📌 Important\n" +
             "🧾 Receipts\n📣 Marketing\n🗑️ Spam / Ignore\n📂 Archived"
  };
  const user = {
    role:    'user',
    content: `Subject: ${subject}\nSnippet: ${snippet}`
  };

  const resp = await openai.chat.completions.create({
    model:       'gpt-3.5-turbo',
    messages:    [system, user],
    temperature: 0
  });
  return resp.choices[0].message.content;
}

// Ensure a Gmail label exists or create it
async function getOrCreateLabel(gmail, name) {
  const labels = await gmail.users.labels.list({ userId: 'me' });
  const found  = labels.data.labels.find(l => l.name === name);
  if (found) return found.id;

  const created = await gmail.users.labels.create({
    userId:      'me',
    requestBody: {
      name,
      labelListVisibility:   'labelShow',
      messageListVisibility: 'show'
    }
  });
  return created.data.id;
}

// Core processing job: classify & label up to 5 unread messages
async function processJob() {
  try {
    const gmail   = await getGmailService();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email   = profile.data.emailAddress;
    const whitelist = loadWhitelist();
    if (!whitelist.includes(email)) {
      console.log(`Skipping ${email}: not in whitelist.`);
      return [];
    }

    const msgsRes = await gmail.users.messages.list({
      userId:     'me',
      q:          'is:unread',
      maxResults: 5
    });
    const msgs = msgsRes.data.messages || [];
    const summary = [];

    for (const m of msgs) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id:     m.id,
        format: 'full'
      });
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snippet = msg.data.snippet;

      const labelName = await classifyEmail(subject, snippet);
      const labelId   = await getOrCreateLabel(gmail, labelName);

      await gmail.users.messages.modify({
        userId: 'me',
        id:     m.id,
        requestBody: {
          addLabelIds:    [labelId, 'UNREAD'],
          removeLabelIds: []
        }
      });

      summary.push({ subject, label: labelName });
    }

    return summary;
  } catch (err) {
    console.error('Error in processJob:', err);
    return [];
  }
}

// Schedule twice daily at 07:00 & 15:00
cron.schedule('0 7 * * *',  () => processJob());
cron.schedule('0 15 * * *', () => processJob());
console.log('Scheduler: runs at 07:00 & 15:00');

// Manual trigger endpoint
app.get('/run-now', async (req, res) => {
  const results = await processJob();
  res.json({ status: 'ok', results });
});

// Redirect root to your frontend
app.get('/', (req, res) => {
  res.redirect(FRONTEND_URL || '/');
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
