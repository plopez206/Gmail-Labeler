// backend/app.js
// Node.js Gmail automation backend using Express, Google OAuth, and OpenAI
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { google } = require('googleapis');
const OpenAI = require('openai').default;  // Default export
const cron = require('node-cron');

// Configuration
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
const REDIRECT_URI = process.env.REDIRECT_URI;

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
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const creds = JSON.parse(raw);
  const conf = creds.web || creds.installed;
  if (!conf) {
    console.error("credentials.json must contain 'web' or 'installed'");
    process.exit(1);
  }
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

// Routes
app.get('/auth', (req, res) => {
  const oAuth2Client = getOAuth2Client();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const oAuth2Client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

    // Auto‑subscribe user
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const whitelist = loadWhitelist();
    if (!whitelist.includes(email)) {
      whitelist.push(email);
      saveWhitelist(whitelist);
    }
    res.send(`✅ Connected and subscribed: ${email}.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication error');
  }
});

// Get authorized Gmail service
async function getGmailService() {
  const oAuth2Client = getOAuth2Client();
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  } else {
    throw new Error('Not authenticated. Visit /auth first.');
  }
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// Classify email using OpenAI
async function classifyEmail(subject, snippet) {
  const system = {
    role: 'system',
    content: `You are an email classifier. Choose exactly one category (emoji included) from this list:\narduino\nCopy\nEdit\n✅ Action Required\n🕒 Follow Up\n🤝 Client\n📌 Important\n🧾 Receipts\n📣 Marketing\n🗑️ Spam / Ignore\n📂 Archived`
  };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };
  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [system, user],
    temperature: 0
  });
  return resp.choices[0].message.content;
}

// Ensure Gmail label exists or create it
async function getOrCreateLabel(gmail, name) {
  const existing = (await gmail.users.labels.list({ userId: 'me' })).data.labels
    .find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return created.data.id;
}

// Process and label unread emails
async function processJob() {
  try {
    const gmail = await getGmailService();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const whitelist = loadWhitelist();
    if (!whitelist.includes(email)) {
      console.log(`Skipping ${email}: not in whitelist.`);
      return [];
    }

    const msgsRes = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 5 });
    if (!msgsRes.data.messages) return [];

    const summary = [];
    for (const m of msgsRes.data.messages) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snippet = msg.data.snippet;
      const label = await classifyEmail(subject, snippet);
      const lid = await getOrCreateLabel(gmail, label);
      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
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

// Schedule twice daily at 07:00 & 15:00
cron.schedule('0 7 * * *', () => processJob());
cron.schedule('0 15 * * *', () => processJob());
console.log('Scheduler: 07:00 & 15:00');

// Manual trigger endpoint
app.get('/run-now', async (req, res) => {
  const results = await processJob();
  res.json({ status: 'ok', results });
});

// Basic home page
app.get('/', (req, res) => {
  res.send(`<h1>Gmail Automation</h1><a href="/auth">Connect & Subscribe</a><br><a href="/run-now">Run Now</a>`);
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
