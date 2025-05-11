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
const FRONTEND_URL     = process.env.FRONTEND_URL;       // Your Netlify frontend URL

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

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Status endpoint: tells frontend if we're authenticated
app.get('/status', (req, res) => {
  const connected = fs.existsSync(TOKEN_PATH);
  res.json({ connected });
});

// Load or initialize whitelist
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}
function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

// OAuth2 client using credentials from env or file
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
    console.error("credentials.json must contain 'web' or 'installed'");
    process.exit(1);
  }
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

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

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const oAuth2Client = getOAuth2Client();
    const { code }     = req.query;
    const { tokens }   = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

    // Auto‑subscribe user
    const gmail   = google.gmail({ version: 'v1', auth: oAuth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email   = profile.data.emailAddress;
    const whitelist = loadWhitelist();
    if (!whitelist.includes(email)) {
      whitelist.push(email);
      saveWhitelist(whitelist);
    }

    // Redirect back to frontend with success flag
    return res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('Error in /auth/callback:', err);
    res.status(500).send('Authentication error');
  }
});

// Helper: get authenticated Gmail client
async function getGmailService() {
  const oAuth2Client = getOAuth2Client();
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Not authenticated. Visit /auth first.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// Use OpenAI to classify email
async function classifyEmail(subject, snippet) {
  const system = {
    role:    'system',
    content: "You are an email classifier. Choose exactly one category (emoji included) from this list:\narduino\nCopy\nEdit\n✅ Action Required\n🕒 Follow Up\n🤝 Client\n📌 Important\n🧾 Receipts\n📣 Marketing\n🗑️ Spam / Ignore\n📂 Archived"
  };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };

  const resp = await openai.chat.completions.create({
    model:       'gpt-3.5-turbo',
    messages:    [system, user],
    temperature: 0
  });

  return resp.choices[0].message.content;
}

// Ensure Gmail label exists or create it
async function getOrCreateLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const found = list.data.labels.find(l => l.name === name);
  if (found) return found.id;

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility:   'labelShow',
      messageListVisibility: 'show'
    }
  });
  return created.data.id;
}

// Main job: classify & label unread emails
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
      userId: 'me',
      maxResults: 5
    });
    const msgs = msgsRes.data.messages || [];
    const summary = [];

    for (const m of msgs) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snippet = msg.data.snippet;

      const label = await classifyEmail(subject, snippet);
      const lid   = await getOrCreateLabel(gmail, label);
      await gmail.users.messages.modify({
        userId: 'me',
        id:     m.id,
        requestBody: { addLabelIds: [lid, 'UNREAD'], removeLabelIds: [] }
      });
      summary.push({ subject, label });
    }

    return summary;
  } catch (err) {
    console.error('Error in processJob:', err);
    return [];
  }
}

// Schedule at 07:00 & 15:00 daily
cron.schedule('0 7 * * *',  () => processJob());
cron.schedule('0 15 * * *', () => processJob());
console.log('Scheduler: runs at 07:00 & 15:00');

// Manual trigger
app.get('/run-now', async (req, res) => {
  const results = await processJob();
  res.json({ status: 'ok', results });
});

// Redirect root to frontend (optional)
app.get('/', (req, res) => {
  res.redirect(FRONTEND_URL || '/');
});

// Start server, bind to PORT and all interfaces
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on port ${PORT}`));
