// backend/app.js
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { google } = require('googleapis');
const { Configuration, OpenAIApi } = require('openai');
const cron = require('node-cron');
const path = require('path');

// Configuración
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
const REDIRECT_URI = process.env.REDIRECT_URI;

// Cliente OpenAI
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// Express app
const app = express();
app.use(cors());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));
app.use(express.json());

// Helpers para whitelist
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}
function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

// OAuth2 client
function getOAuth2Client() {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  return new google.auth.OAuth2(creds.web.client_id, creds.web.client_secret, REDIRECT_URI);
}

// Rutas OAuth
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

    // Auto‑subscribe
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const wl = loadWhitelist();
    if (!wl.includes(email)) {
      wl.push(email);
      saveWhitelist(wl);
    }
    res.send(`✅ Conectado y suscrito: ${email}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error en autenticación');
  }
});

// Obtén servicio Gmail autorizado
async function getGmailService() {
  const client = getOAuth2Client();
  if (fs.existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  } else {
    throw new Error('No autenticado');
  }
  return google.gmail({ version: 'v1', auth: client });
}

// Funciones de clasificación y etiquetado
async function classifyEmail(subject, snippet) {
  const system = { role: 'system', content:
    `You are an email classifier. Choose exactly one category (emoji included) from:\narduino\nCopy\nEdit\n✅ Action Required\n🕒 Follow Up\n🤝 Client\n📌 Important\n🧾 Receipts\n📣 Marketing\n🗑️ Spam / Ignore\n📂 Archived` };
  const user = { role: 'user', content: `Subject: ${subject}\nSnippet: ${snippet}` };
  const resp = await openai.createChatCompletion({ model: 'gpt-3.5-turbo', messages: [system, user], temperature: 0 });
  return resp.data.choices[0].message.content.trim();
}

async function getOrCreateLabel(gmail, name) {
  const labels = await gmail.users.labels.list({ userId: 'me' });
  const existing = labels.data.labels.find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
  return created.data.id;
}

async function processJob() {
  try {
    const gmail = await getGmailService();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    const wl = loadWhitelist();
    if (!wl.includes(email)) return [];
    const msgs = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 5 });
    if (!msgs.data.messages) return [];
    const summary = [];
    for (let m of msgs.data.messages) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id });
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
      const snippet = msg.data.snippet;
      const label = await classifyEmail(subject, snippet);
      const lid = await getOrCreateLabel(gmail, label);
      await gmail.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [lid, 'UNREAD'], removeLabelIds: [] } });
      summary.push({ subject, label });
    }
    return summary;
  } catch (err) {
    console.error(err);
    return [];
  }
}

// Scheduler: 07:00 & 15:00
cron.schedule('0 7 * * *', () => processJob());
cron.schedule('0 15 * * *', () => processJob());

// Endpoints
app.get('/run-now', async (req, res) => {
  const results = await processJob();
  res.json({ status: 'ok', results });
});

app.get('/', (req, res) => {
  res.send(`<h1>Gmail Automation</h1>
            <a href="/auth">Conectar & Suscribir</a><br>
            <a href="/run-now">Run Now</a>`);
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend escuchando en puerto ${PORT}`));
