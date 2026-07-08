require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const crypto = require('crypto');

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

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({ users: [], tasks: [], logs: [], energy: [], shares: [], reminders: [] }).write();

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const { email, password, name } = req.body;
  if(!email || !password) return res.status(400).json({ error: 'Нужны email и пароль' });
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
  const { email, password } = req.body;
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
  db.get('tasks').find({ id: req.params.id }).assign(req.body).write();
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
    const steps = await splitWithClaude(task.title);
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
  if(!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не задан на сервере');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
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
  const data = await response.json();
  if(data.error) throw new Error(data.error.message || 'Ошибка Claude API');
  const textBlock = data.content.find(b => b.type === 'text');
  let raw = textBlock ? textBlock.text : '[]';
  raw = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
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

app.listen(PORT, () => {
  console.log(`Flow server running on http://localhost:${PORT}`);
});
