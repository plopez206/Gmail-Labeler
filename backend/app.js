// backend/app.js
// Node.js Gmail automation backend using Express, Google OAuth, OpenAI & Supabase
// Focused on best quality‑to‑cost ratio (minimal tokens, high precision)

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const { google } = require('googleapis');
const OpenAI  = require('openai').default;
const { createClient } = require('@supabase/supabase-js');

// ────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────
const SCOPES          = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS     = process.env.GOOGLE_CREDENTIALS_JSON;
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const REDIRECT_URI    = process.env.REDIRECT_URI;
const FRONTEND_URL    = process.env.FRONTEND_URL;
const POLL_INTERVAL   = Number(process.env.POLL_INTERVAL_MS) || 60_000; // 1 min
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';     // cost‑efficient

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TABLE = 'users';

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────────────────────────────────────────────────────────────
// 2. Express
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
// 3. Helpers
// ────────────────────────────────────────────────────────────
function getOAuth2Client() {
  const raw = CREDENTIALS || fs.readFileSync(CREDENTIALS_PATH, 'utf8');
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

// Fixed labels with professional emojis
const LABELS = {
  important:        'Important 🔔',
  action_required:  'Action Required ✅',
  urgent:           'Urgent 🚨',
  newsletter:       'Newsletter 📰',
  advertising:      'Advertising 📢',
  spam:             'Spam or Ignore 🗑️',
  personal:         'Personal 💌',
  receipts:         'Receipts 🧾',
  travel:           'Travel ✈️'
};
const LABEL_VALUES = Object.values(LABELS);

async function classifyEmail(from, subject, snippet, body) {
  // Compact prompt → fewer tokens
  const sys = {
    role: 'system',
    content: `Return ONLY one of these labels:\n${LABEL_VALUES.join('\n')}`
  };
  const usr = {
    role: 'user',
    content: `From:${from}\nSubject:${subject}\nSnippet:${snippet}\nBody:${body.slice(0,200)}`
  };

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [sys, usr],
    temperature: 0,
    max_tokens: 10 // cost control
  });
  const out = resp.choices[0].message.content.trim();
  return LABEL_VALUES.includes(out) ? out : LABELS.spam; // default to spam label
}

async function getOrCreateLabel(gmail, name) {
  const wanted = name.toLowerCase();
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const hit = data.labels.find(l => l.name.toLowerCase() === wanted);
  if (hit) return hit.id;
  try {
    const c = await gmail.users.labels.create({ userId: 'me', requestBody:{ name, labelListVisibility:'labelShow', messageListVisibility:'show' }});
    return c.data.id;
  } catch {
    const fresh = (await gmail.users.labels.list({ userId:'me' })).data.labels;
    return fresh.find(l => l.name.toLowerCase() === wanted)?.id || fresh.find(l=>l.name==='INBOX')?.id;
  }
}

async function processJobForEmail(email) {
  try {
    const gmail = await getGmailService(email);
    const { data } = await gmail.users.messages.list({ userId:'me', labelIds:['INBOX'], q:'is:unread', maxResults:20 });
    for (const m of data.messages || []) {
      const msg = await gmail.users.messages.get({ userId:'me', id:m.id, format:'full' });
      const hdr = msg.data.payload.headers;
      const from    = hdr.find(h=>h.name==='From')?.value || '';
      const subject = hdr.find(h=>h.name==='Subject')?.value || '';
      const bodyTxt = extractPlainText(msg.data.payload);
      const label   = await classifyEmail(from, subject, msg.data.snippet, bodyTxt);
      const labelId = await getOrCreateLabel(gmail, label);
      await gmail.users.messages.modify({ userId:'me', id:m.id, requestBody:{ addLabelIds:[labelId], removeLabelIds:[] }});
    }
  } catch(err) { console.error(`Process ${email}:`, err); }
}

async function runAll() {
  const { data: users } = await supabase.from(TABLE).select('email');
  for (const u of users || []) await processJobForEmail(u.email);
}
// Start polling: runs `runAll()` every POLL_INTERVAL milliseconds (default: 60000 ms = 1 minute)
setInterval(runAll, POLL_INTERVAL);
console.log(`Polling every ${POLL_INTERVAL/1000}s`);

// ───── Routes ─────
app.get('/health', (_q,r)=>r.send('OK'));
app.get('/status', async (_q,r)=>{
  const { data } = await supabase.from(TABLE).select('email');
  r.json({ count:data?.length||0 });
});
app.get('/auth', (_q,r)=>{
  const url = getOAuth2Client().generateAuthUrl({ access_type:'offline', scope:SCOPES, prompt:'consent' });
  r.redirect(url);
});
app.get('/auth/callback', async (req,res)=>{
  try {
    const client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const gmail = google.gmail({ version:'v1', auth:client });
    const email = (await gmail.users.getProfile({ userId:'me' })).data.emailAddress;
    await supabase.from(TABLE).upsert({ email, tokens },{ onConflict:'email' });
    res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch(e){ console.error('OAuth:',e); res.status(500).send('Auth error'); }
});
app.get('/run-now', async (_q,r)=>{ await runAll(); r.json({ status:'ok' });});
app.get('/', (_q,r)=>r.redirect(FRONTEND_URL||'/'));

// ───── Start ─────
const PORT = process.env.PORT || 8080;
app.listen(PORT,'0.0.0.0',()=>console.log('API on',PORT));
