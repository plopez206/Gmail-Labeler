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
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

// Configuración de OAuth/Gmail
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
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

  if (error || !data) throw new Error(`Usuario no autenticado: ${email}`);

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
    content: `Eres un clasificador de emails. Según remitente, asunto, fragmento y cuerpo, elige UNA etiqueta EXACTA:
- Important
- Action Required
- Urgent
- Newsletter
- Advertising
- Spam or Ignore`
  };
  const examples = [{
    from: 'noreply@github.com', subject: 'Please verify your email', snippet: 'Click aquí para verificar tu cuenta', body: '', label: 'Action Required'
  },{
    from: 'offers@tienda.com', subject: 'Gran oferta de verano', snippet: '50% dto en todos los productos', body: '', label: 'Advertising'
  },{
    from: 'newsletter@medio.com', subject: 'Resumen semanal de noticias', snippet: 'Lo más destacado de esta semana en política', body: '', label: 'Newsletter'
  }];
  let prompt = '';
  examples.forEach(ex => {
    prompt += `From: ${ex.from}\nSubject: ${ex.subject}\nSnippet: ${ex.snippet}\nBody excerpt: ${ex.body}\n→ ${ex.label}\n\n`;
  });
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
  const valid = ["Important","Action Required","Urgent","Newsletter","Advertising","Spam or Ignore","Uncategorized"];
  return valid.includes(label) ? label : "Uncategorized";
}

async function getOrCreateLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  let lbl = data.labels?.find(l => l.name === name);
  if (lbl) return lbl.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return created.data.id;
}

// ------------------ Rutas ------------------ //

app.get('/health', (_req, res) => res.send('OK'));

app.get('/status', async (_req, res) => {
  const { data: users, error } = await supabase.from(TABLE).select('email');
  res.json({ count: users?.length ?? 0, error });
});

app.get('/auth', (_req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;

    const { data, error } = await supabase
      .from(TABLE)
      .upsert({ email, tokens }, { onConflict: 'email' });
    console.log('Upsert result:', { data, error });
    if (error) {
      console.error('Supabase upsert error:', error);
      return res.status(500).send('Error guardando tokens en la base de datos');
    }

    res.redirect(`${FRONTEND_URL}?authed=true`);
  } catch (err) {
    console.error('Error en OAuth:', err);
    res.status(500).send('Error de autenticación');
  }
});

async function processJobForEmail(email) {
  try {
    const gmail = await getGmailService(email);
    const { data } = await gmail.users.messages.list({
      userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 20
    });

    for (const m of data.messages || []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const fromH = headers.find(h => h.name === 'From');
      const subjectH = headers.find(h => h.name === 'Subject');
      const from = fromH?.value || '';
      const subject = subjectH?.value || '(no subject)';
      const snippet = msg.data.snippet;

      const fullBody = extractPlainText(msg.data.payload) || '';
      const bodyExcerpt = fullBody.slice(0, 300).replace(/\s+/g, ' ').trim();

      const labelName = await classifyEmail(from, subject, snippet, bodyExcerpt);
      const labelId = await getOrCreateLabel(gmail, labelName);
      await gmail.users.messages.modify({
        userId: 'me', id: m.id,
        requestBody: { addLabelIds: [labelId], removeLabelIds: [] }
      });
    }
  } catch (err) {
    console.error(`Error procesando ${email}:`, err);
  }
}

async function runAll() {
  const { data: users } = await supabase.from(TABLE).select('email');
  for (const u of users || []) await processJobForEmail(u.email);
}

cron.schedule('0 7 * * *', runAll, { timezone: 'America/Chicago' });
cron.schedule('0 16 * * *', runAll, { timezone: 'America/Chicago' });
console.log('Cron configurado para 07:00 y 16:00 America/Chicago');

app.get('/run-now', async (_req, res) => { await runAll(); res.json({ status: 'ok' }); });
app.get('/whitelist', async (_req, res) => {
  const { data: users } = await supabase.from(TABLE).select('email');
  res.json({ whitelist: users?.map(u => u.email) || [] });
});
app.get('/', (_req, res) => res.redirect(FRONTEND_URL || '/'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Escuchando en puerto ${PORT}`));
