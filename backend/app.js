// backend/app.js
// Node.js Gmail automation backend using Express, Google OAuth, OpenAI y Supabase

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { google } = require('googleapis');
const OpenAI = require('openai').default;
const { createClient } = require('@supabase/supabase-js');

// Configuración de OAuth/Gmail\const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Inicializar Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TABLE = 'users'; // tabla con columnas: email (PK) y tokens (JSON)

// Inicializar OpenAI
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

// ------------------ Utilidades ------------------ //

function getOAuth2Client() {
  let raw;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    raw = process.env.GOOGLE_CREDENTIALS_JSON;
  } else {
    raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  }
  const creds = JSON.parse(raw);
  const conf  = creds.web || creds.installed;
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

async function getGmailService(email) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('tokens')
    .eq('email', email)
    .single();

  if (error || !data) throw new Error(`User not authenticated: ${email}`);

  const client = getOAuth2Client();
  client.setCredentials(data.tokens);
  return google.gmail({ version: 'v1', auth: client });
}

function extractPlainText(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    const buff = Buffer.from(payload.body.data, 'base64');
    return buff.toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

async function classifyEmail(from, subject, snippet, body) {
  const system = {
    role: 'system',
    content: `You are an email classifier. Based on sender, subject, snippet, and body, choose EXACTLY ONE label:
- Important
- Action Required
- Urgent
- Newsletter
- Advertising
- Spam or Ignore
- Personal
- Receipts
- Travel
If none match, return a dynamic label with prefix "Custom/" (e.g., "Custom/Billing Reminder").`}
  const examples = [
    { from: 'noreply@github.com', subject: 'Verify your email', snippet: 'Please click here to verify', body: '', label: 'Action Required' },
    { from: 'offers@store.com', subject: 'Big Summer Sale', snippet: 'Up to 50% off everything', body: '', label: 'Advertising' },
    { from: 'news@weekly.com', subject: 'Weekly Digest', snippet: 'Top stories this week', body: '', label: 'Newsletter' }
  ];
  let prompt = examples.map(ex =>
    `From: ${ex.from}\nSubject: ${ex.subject}\nSnippet: ${ex.snippet}\nBody excerpt: ${ex.body}\n→ ${ex.label}\n\n`
  ).join('');
  const user = {
    role: 'user',
    content: prompt +
      `From: ${from}\nSubject: ${subject}\nSnippet: ${snippet}\nBody excerpt: ${body}`
  };

  const resp = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [system, user],
    temperature: 0
  });
  const label = resp.choices[0].message.content.trim();
  const valid = ["Important","Action Required","Urgent","Newsletter","Advertising","Spam or Ignore"];
  if (valid.includes(label)) return label;
  return label.startsWith('Custom/') ? label : `Custom/${label}`;
}

async function getOrCreateLabel(gmail, name) {
  // Normalize name
  const targetName = name.trim().toLowerCase();
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  // Try find existing label (case-insensitive)
  const existing = data.labels.find(l => l.name.trim().toLowerCase() === targetName);
  if (existing) return existing.id;
  // If not found, attempt to create
  try {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
    return created.data.id;
  } catch (e) {
    console.warn(`Could not create label '${name}':`, e.errors || e.message);
    // On invalid label name, fallback to existing system label if any
    const refresh = await gmail.users.labels.list({ userId: 'me' });
    const found = refresh.data.labels.find(l => l.name.trim().toLowerCase() === targetName);
    if (found) return found.id;
    // As last resort, return INBOX label
    const inbox = refresh.data.labels.find(l => l.name === 'INBOX');
    return inbox ? inbox.id : undefined;
  }
}

async function processJobForEmail(email) {
  try {
    const gmail = await getGmailService(email);
    const { data } = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 20 });
    for (const m of data.messages || []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snippet = msg.data.snippet;
      const body = extractPlainText(msg.data.payload).slice(0, 300).replace(/\s+/g, ' ').trim();
      const labelName = await classifyEmail(from, subject, snippet, body);
      const labelId = await getOrCreateLabel(gmail, labelName);
      await gmail.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [labelId], removeLabelIds: [] }});
    }
  } catch (err) {
    console.error(`Error processing ${email}:`, err);
  }
}

async function runAll() {
  const { data: users } = await supabase.from(TABLE).select('email');
  for (const u of users || []) await processJobForEmail(u.email);
}

// Polling every minute instead of scheduled times
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 60 * 1000;
setInterval(runAll, POLL_INTERVAL_MS);
console.log(`Polling every ${POLL_INTERVAL_MS/1000} seconds for new emails`);

// Express routes
app.get('/health', (_req, res) => res.send('OK'));
app.get('/status', async (_req, res) => {
  const { data: users, error } = await supabase.from(TABLE).select('email');
  res.json({ count: users?.length ?? 0, error });
});
app.get('/auth', (_req, res) => {
  const url = getOAuth2Client().generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    const gmail = google.gmail({ version: 'v1', auth: (client.setCredentials(tokens), client) });
    const email = (await gmail.users.getProfile({ userId: 'me' })).data.emailAddress;
    const { error } = await supabase.from(TABLE).upsert({ email, tokens }, { onConflict: 'email' });
    if (error) throw error;
    res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Authentication error');
  }
});
app.get('/run-now', async (_req, res) => { await runAll(); res.json({ status: 'ok' }); });
app.get('/whitelist', async (_req, res) => {
  const { data: users } = await supabase.from(TABLE).select('email');
  res.json({ whitelist: users?.map(u => u.email) || [] });
});
app.get('/', (_req, res) => res.redirect(FRONTEND_URL || '/'));

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
