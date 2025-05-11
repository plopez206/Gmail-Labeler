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
const WHITELIST_PATH   = path.join(__dirname, 'whitelist.json');
const TOKENS_DIR       = path.join(__dirname, 'tokens');
const REDIRECT_URI     = process.env.REDIRECT_URI;       // Must match Google OAuth settings
const FRONTEND_URL     = process.env.FRONTEND_URL;       // Your frontend URL

// Ensure tokens directory exists
if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR);

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
  const users = loadWhitelist();
  return res.json({ users, tokensDir: fs.existsSync(TOKENS_DIR) });
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

    // Get user email
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;

    // Save token per user
    const tokenFile = path.join(TOKENS_DIR, `${email}.json`);
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));

    // Auto-subscribe to whitelist
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

// Get Gmail service for a specific user
async function getGmailService(email) {
  const client = getOAuth2Client();
  const tokenFile = path.join(TOKENS_DIR, `${email}.json`);
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`User ${email} not authenticated`);
  }
  const tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: client });
}

// Classifier using new labels
async function classifyEmail(subject, snippet) {
  const system = {
    role: 'system',
    content: `You are an email classifier. Based only on subject and snippet, assign ONE category:

- Important
- Action Required
- Urgent
- Newsletter
- Advertising
- Spam or Ignore

Return just the category name.`
  };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };
  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [system, user],
    temperature: 0
  });
  return resp.choices[0].message.content.trim();
}

// Ensure label exists in user's Gmail
async function getOrCreateLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  let lbl = data.labels.find(l => l.name === name);
  if (lbl) return lbl.id;
  try {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
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

// Process job for a single user
async function processJobForEmail(email) {
  try {
    const gmail = await getGmailService(email);
    const res = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 20 });
    const msgs = res.data.messages || [];
    for (const m of msgs) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const hdrs = msg.data.payload.headers;
      const subj = hdrs.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snip = msg.data.snippet;
      const labelName = await classifyEmail(subj, snip);
      const lid = await getOrCreateLabel(gmail, labelName);
      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
        requestBody: { addLabelIds: [lid], removeLabelIds: [] }
      });
    }
  } catch (err) {
    console.error(`Error processing ${email}:`, err);
  }
}

// Cron: run for all whitelisted users
async function runAll() {
  const wl = loadWhitelist();
  for (const email of wl) {
    await processJobForEmail(email);
  }
}
cron.schedule('0 7 * * *', runAll);
cron.schedule('0 16 * * *', runAll); // daily at 16:00 (4 PM)
console.log('Scheduler set for daily runs at 07:00 and 16:00');

// Endpoints
app.get('/run-now', async (req, res) => {
  const wl = loadWhitelist();
  const results = [];
  for (const email of wl) {
    results.push({ email, status: await processJobForEmail(email) });
  }
  res.json({ status: 'ok', results });
});
app.get('/whitelist', (req, res) => res.json({ whitelist: loadWhitelist() }));
app.get('/', (req, res) => res.redirect(FRONTEND_URL || '/'));

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
