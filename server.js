require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored){
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

const DATA_DIR = process.env.FLOW_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'db.json');
const backupDir = path.join(DATA_DIR, 'backups');
const legacyDbPath = path.join(__dirname, 'db.json');
if(!fs.existsSync(DB_PATH) && fs.existsSync(legacyDbPath)) fs.copyFileSync(legacyDbPath, DB_PATH);
if(fs.existsSync(DB_PATH)){
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `db-${new Date().toISOString().slice(0,10)}.json`);
  if(!fs.existsSync(backup)) fs.copyFileSync(DB_PATH, backup);
}
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ users: [], tasks: [], logs: [], energy: [], shares: [], reminders: [] }).write();

const secretFile = path.join(DATA_DIR, '.jwt-secret');
let JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if(!JWT_SECRET || /change-this|replace-with/i.test(JWT_SECRET)){
  JWT_SECRET = fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : crypto.randomBytes(48).toString('hex');
  if(!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(ANTHROPIC_API_KEY && !/your-key|ваш-ключ/i.test(ANTHROPIC_API_KEY)) }));

// ---------- auth helpers ----------
function sign(userId){
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '90d' });
}
function auth(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Нет токена' });
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  }catch(e){
    return res.status(401).json({ error: 'Неверный или истёкший токен' });
  }
}

// ---------- auth routes ----------
app.post('/api/auth/register', (req, res) => {
  let { email, password, name } = req.body;
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  name = typeof name === 'string' ? name.trim().slice(0,80) : '';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Введите корректный email' });
  if(typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 8 до 128 символов' });
  const existing = db.get('users').find({ email }).value();
  if(existing) return res.status(409).json({ error: 'Пользователь с таким email уже есть' });
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    name: name || '',
    createdAt: Date.now()
  };
  db.get('users').push(user).write();
  const token = sign(user.id);
  res.json({ token, name: user.name });
});

app.post('/api/auth/login', (req, res) => {
  let { email, password } = req.body;
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const user = db.get('users').find({ email }).value();
  if(!user || !verifyPassword(password, user.passwordHash)){
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  const token = sign(user.id);
  res.json({ token, name: user.name });
});

// ---------- profile ----------
app.get('/api/me', auth, (req, res) => {
  const user = db.get('users').find({ id: req.userId }).value();
  if(!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ name: user.name, email: user.email });
});

app.put('/api/me', auth, (req, res) => {
  const { name } = req.body;
  db.get('users').find({ id: req.userId }).assign({ name: name || '' }).write();
  res.json({ ok: true });
});

// ---------- tasks ----------
app.get('/api/tasks', auth, (req, res) => {
  const tasks = db.get('tasks').filter({ userId: req.userId }).value();
  res.json(tasks);
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, context, urgency, due } = req.body;
  if(!title) return res.status(400).json({ error: 'Нужен title' });
  const task = {
    id: crypto.randomUUID(),
    userId: req.userId,
    title,
    context: context || 'other',
    urgency: urgency || 'normal',
    due: due || null,
    done: false,
    createdAt: Date.now()
  };
  db.get('tasks').push(task).write();
  res.json(task);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = db.get('tasks').find({ id: req.params.id, userId: req.userId }).value();
  if(!task) return res.status(404).json({ error: 'Задача не найдена' });
  const allowed = {};
  if(typeof req.body.done === 'boolean') allowed.done = req.body.done;
  if(typeof req.body.title === 'string') allowed.title = req.body.title.trim().slice(0,500);
  if(['work','home','errands','personal','other'].includes(req.body.context)) allowed.context = req.body.context;
  if(['low','normal','high'].includes(req.body.urgency)) allowed.urgency = req.body.urgency;
  db.get('tasks').find({ id: req.params.id, userId: req.userId }).assign(allowed).write();
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  db.get('tasks').remove({ id: req.params.id, userId: req.userId }).write();
  res.json({ ok: true });
});

// split a task into steps via Claude, replacing the original
app.post('/api/tasks/:id/split', auth, async (req, res) => {
  const task = db.get('tasks').find({ id: req.params.id, userId: req.userId }).value();
  if(!task) return res.status(404).json({ error: 'Задача не найдена' });
  try{
    let steps;
    try { steps = await splitWithClaude(task.title); }
    catch(e) { steps = localSplit(task.title); }
    db.get('tasks').remove({ id: task.id }).write();
    const newTasks = steps.map(s => ({
      id: crypto.randomUUID(),
      userId: req.userId,
      title: s,
      context: task.context,
      urgency: task.urgency,
      due: null,
      done: false,
      createdAt: Date.now()
    }));
    newTasks.forEach(t => db.get('tasks').push(t).write());
    res.json(newTasks);
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Не получилось разбить задачу' });
  }
});

// ---------- conversational parsing ----------
app.post('/api/parse', auth, async (req, res) => {
  const { text } = req.body;
  if(!text) return res.status(400).json({ error: 'Нужен текст' });
  try{
    const parsed = await parseWithClaude(text);
    const tasks = parsed.map(t => ({
      id: crypto.randomUUID(),
      userId: req.userId,
      title: t.title,
      context: t.context || 'other',
      urgency: t.urgency || 'normal',
      due: t.due || null,
      done: false,
      createdAt: Date.now()
    }));
    tasks.forEach(t => db.get('tasks').push(t).write());
    res.json(tasks);
  }catch(e){
    console.error(e);
    // graceful fallback: add as single raw task
    const task = {
      id: crypto.randomUUID(), userId: req.userId, title: text,
      context: 'other', urgency: 'normal', due: null, done: false, createdAt: Date.now()
    };
    db.get('tasks').push(task).write();
    res.json([task]);
  }
});

async function callClaude(systemPrompt, userText, maxTokens){
  if(!ANTHROPIC_API_KEY || /your-key|ваш-ключ/i.test(ANTHROPIC_API_KEY)) throw new Error('ANTHROPIC_API_KEY не задан на сервере');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 25000);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }]
    })
  });
  clearTimeout(timer);
  const data = await response.json();
  if(data.error) throw new Error(data.error.message || 'Ошибка Claude API');
  const textBlock = data.content.find(b => b.type === 'text');
  let raw = textBlock ? textBlock.text : '[]';
  raw = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function localSplit(title){
  const clean = String(title || '').trim();
  const parts = clean.split(/[,;]|\s+(?:и затем|затем|потом|после этого|и)\s+/i).map(s=>s.trim()).filter(Boolean);
  if(parts.length >= 2) return parts.slice(0,4);
  return [`Подготовиться: ${clean}`, `Начать выполнение: ${clean}`, `Проверить результат: ${clean}`];
}

async function parseWithClaude(text){
  const systemPrompt = `Ты разбираешь свободный текст пользователя на отдельные дела/задачи.
Верни ТОЛЬКО валидный JSON массив, без пояснений, без markdown.
Формат каждого элемента: {"title": string, "context": одно из ["work","home","errands","personal","other"], "urgency": одно из ["low","normal","high"], "due": string или null}
Если в тексте несколько дел — раздели их. Если дело звучит важно/срочно — urgency: "high".`;
  const parsed = await callClaude(systemPrompt, text, 1000);
  if(!Array.isArray(parsed)) throw new Error('not an array');
  return parsed;
}

async function splitWithClaude(title){
  const systemPrompt = `Раздели крупную задачу пользователя на 2-4 маленьких конкретных шага.
Верни ТОЛЬКО валидный JSON массив строк, без пояснений, без markdown.`;
  const parsed = await callClaude(systemPrompt, title, 500);
  if(!Array.isArray(parsed)) throw new Error('not an array');
  return parsed;
}

// ---------- energy ----------
app.get('/api/energy/:date', auth, (req, res) => {
  const rec = db.get('energy').find({ userId: req.userId, date: req.params.date }).value();
  res.json({ level: rec ? rec.level : 'normal' });
});

app.put('/api/energy/:date', auth, (req, res) => {
  const { level } = req.body;
  const existing = db.get('energy').find({ userId: req.userId, date: req.params.date }).value();
  if(existing){
    db.get('energy').find({ userId: req.userId, date: req.params.date }).assign({ level }).write();
  } else {
    db.get('energy').push({ userId: req.userId, date: req.params.date, level }).write();
  }
  res.json({ ok: true });
});

// ---------- log (anti-todo) ----------
app.get('/api/log/:date', auth, (req, res) => {
  const entries = db.get('logs').filter({ userId: req.userId, date: req.params.date }).value();
  res.json(entries.map(e => e.text));
});

app.post('/api/log/:date', auth, (req, res) => {
  const { text } = req.body;
  if(!text) return res.status(400).json({ error: 'Нужен текст' });
  db.get('logs').push({ id: crypto.randomUUID(), userId: req.userId, date: req.params.date, text, createdAt: Date.now() }).write();
  res.json({ ok: true });
});

app.get('/api/log-week', auth, (req, res) => {
  const days = [];
  for(let i=0;i<7;i++){
    const d = new Date();
    d.setDate(d.getDate()-i);
    days.push(d.toISOString().slice(0,10));
  }
  const result = days.map(date => ({
    date,
    entries: db.get('logs').filter({ userId: req.userId, date }).value().map(e=>e.text)
  })).filter(d => d.entries.length > 0);
  res.json(result);
});

// ---------- reminder ----------
app.get('/api/reminder', auth, (req, res) => {
  const rec = db.get('reminders').find({ userId: req.userId }).value();
  res.json({ time: rec ? rec.time : null });
});

app.put('/api/reminder', auth, (req, res) => {
  const { time } = req.body;
  const existing = db.get('reminders').find({ userId: req.userId }).value();
  if(existing){
    db.get('reminders').find({ userId: req.userId }).assign({ time }).write();
  } else {
    db.get('reminders').push({ userId: req.userId, time }).write();
  }
  res.json({ ok: true });
});

// ---------- sharing ----------
app.post('/api/share', auth, (req, res) => {
  let existing = db.get('shares').find({ userId: req.userId }).value();
  let code;
  if(existing){
    code = existing.code;
  } else {
    code = crypto.randomBytes(4).toString('hex').toUpperCase();
    db.get('shares').push({ userId: req.userId, code }).write();
  }
  res.json({ code });
});

app.get('/api/share/:code', (req, res) => {
  const share = db.get('shares').find({ code: req.params.code.toUpperCase() }).value();
  if(!share) return res.status(404).json({ error: 'Код не найден' });
  const tasks = db.get('tasks').filter({ userId: share.userId, done: false }).value();
  res.json({ tasks: tasks.map(t => ({ title: t.title })) });
});

// fallback to index.html for the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startServer(port = Number(PORT) || 3000, host = '127.0.0.1'){
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`Flow server running on http://${host}:${actualPort}`);
      resolve({ server, port: actualPort });
    });
    server.on('error', reject);
  });
}

if(require.main === module){
  startServer().catch(e=>{ console.error('Не удалось запустить Flow:', e.message); process.exitCode = 1; });
}

module.exports = { app, startServer };
