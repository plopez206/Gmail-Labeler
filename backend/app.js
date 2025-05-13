// backend/app.js
// Node.js Gmail automation backend using Express, Google OAuth, OpenAI & Supabase
// Labels at 07:00 and 15:00 only

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const cron    = require('node-cron');
const { google } = require('googleapis');
const OpenAI  = require('openai').default;
const { createClient } = require('@supabase/supabase-js');

// ────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────
const SCOPES           = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS       = process.env.GOOGLE_CREDENTIALS_JSON;
const CREDENTIALS_PATH  = path.join(__dirname, 'credentials.json');
const REDIRECT_URI      = process.env.REDIRECT_URI;
const FRONTEND_URL      = process.env.FRONTEND_URL;
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TABLE    = 'users';
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────────────────────────────────────────────────────────────
// 2. Express setup
// ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// ────────────────────────────────────────────────────────────
// 3. Helpers (unchanged)
// ────────────────────────────────────────────────────────────
function getOAuth2Client() {
  const raw   = CREDENTIALS || fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const creds = JSON.parse(raw);
  const conf  = creds.web || creds.installed;
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT_URI);
}

async function getGmailService(email) {
  const { data, error } = await supabase.from(TABLE).select('tokens').eq('email', email).single();
  if (error || !data) throw new Error(`User not authenticated: ${email}`);
  const client = getOAuth2Client();
  client.setCredentials(data.tokens);
  return google.gmail({ version: 'v1', auth: client });
}

function extractPlainText(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  return '';
}

const LABELS = {
  important:       'Important 🔔',
  action_required: 'Action Required ✅',
  urgent:          'Urgent 🚨',
  newsletter:      'Newsletter 📰',
  advertising:     'Advertising 📢',
  spam:            'Spam or Ignore 🗑️',
  personal:        'Personal 💌',
  receipts:        'Receipts 🧾',
  travel:          'Travel ✈️'
};
const LABEL_VALUES = Object.values(LABELS);

async function classifyEmail(from, subject, snippet, body) {
  const sys = {
    role: 'system',
    content: `Pick exactly one label:\n${LABEL_VALUES.join('\n')}`
  };
  const usr = {
    role: 'user',
    content: `From:${from}\nSubject:${subject}\nSnippet:${snippet}\nBody:${body.slice(0,200)}`
  };
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [sys, usr],
    temperature: 0,
    max_tokens: 10
  });
  const out = resp.choices[0].message.content.trim();
  return LABEL_VALUES.includes(out) ? out : LABELS.spam;
}

async function getOrCreateLabel(gmail, name) {
  const want = name.toLowerCase();
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const hit = data.labels.find(l => l.name.toLowerCase() === want);
  if (hit) return hit.id;
  try {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
    return created.data.id;
  } catch {
    const fresh = (await gmail.users.labels.list({ userId: 'me' })).data.labels;
    return fresh.find(l => l.name.toLowerCase() === want)?.id
        || fresh.find(l => l.name === 'INBOX')?.id;
  }
}

async function processJobForEmail(email) {
  try {
    const gmail = await getGmailService(email);
    // preload labels
    const { data: labels } = await gmail.users.labels.list({ userId: 'me' });
    const ourIds = new Set(labels
      .filter(l => LABEL_VALUES.includes(l.name))
      .map(l => l.id));
    const nameId = new Map(labels.map(l => [l.name, l.id]));

    const { data } = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      q: 'is:unread',
      maxResults: 20
    });

    for (const m of data.messages || []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      if (msg.data.labelIds.some(id => ourIds.has(id))) continue;

      const hdr     = msg.data.payload.headers;
      const from    = hdr.find(h => h.name==='From')?.value  || '';
      const subject = hdr.find(h => h.name==='Subject')?.value || '';
      const snippet = msg.data.snippet;
      const body    = extractPlainText(msg.data.payload);

      const labelName = await classifyEmail(from, subject, snippet, body);
      let labelId     = nameId.get(labelName);
      if (!labelId) {
        labelId = await getOrCreateLabel(gmail, labelName);
        nameId.set(labelName, labelId);
        ourIds.add(labelId);
      }

      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
        requestBody: { addLabelIds: [labelId], removeLabelIds: [] }
      });
    }
  } catch (err) {
    console.error(`Error processing ${email}:`, err);
  }
}

async function runAll() {
  const { data: users } = await supabase.from(TABLE).select('email');
  for (const u of users || []) {
    await processJobForEmail(u.email);
  }
}

// ────────────────────────────────────────────────────────────
// 4. Scheduling: 07:00 & 15:00 America/Chicago
// ────────────────────────────────────────────────────────────
cron.schedule('0 7 * * *', () => runAll(),   { timezone: 'America/Chicago' });
cron.schedule('0 15 * * *', () => runAll(),  { timezone: 'America/Chicago' });
console.log('Scheduled jobs at 07:00 and 15:00 America/Chicago');

// ────────────────────────────────────────────────────────────
// 5. Routes
// ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('OK'));
app.get('/status', async (_req, res) => {
  const { data } = await supabase.from(TABLE).select('email');
  res.json({ count: data?.length || 0 });
});
app.get('/auth', (_req, res) => {
  const url = getOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  try {
    const client   = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const gmail    = google.gmail({ version: 'v1', auth: client });
    const email    = (await gmail.users.getProfile({ userId: 'me' })).data.emailAddress;
    await supabase.from(TABLE).upsert({ email, tokens }, { onConflict:'email' });
    res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (e) {
    console.error('OAuth error:', e);
    res.status(500).send('Authentication error');
  }
});
app.get('/run-now', async (_req, res) => {
  await runAll();
  res.json({ status: 'ok' });
});
app.get('/', (_req, res) =>
  res.send(`
    <h1>MailCortex API</h1>
    <p>Service is running. Use <code>/health</code> or <code>/status</code>.</p>
  `)
);

// ────────────────────────────────────────────────────────────
// 6. Start server
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on port ${PORT}`));
