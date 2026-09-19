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
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, localPlanner: true, version: '1.3.1' }));

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
  // Локальный быстрый вход: admin / admin. Использует существующий профиль, чтобы не терять задачи.
  if(email === 'admin' && password === 'admin'){
    let localUser = db.get('users').value()[0];
    if(!localUser){
      localUser = { id: crypto.randomUUID(), email:'admin@flow.local', passwordHash:hashPassword('admin'), name:'Admin', createdAt:Date.now() };
      db.get('users').push(localUser).write();
    }
    return res.json({ token: sign(localUser.id), name: localUser.name });
  }
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

app.get('/api/me/stats', auth, (req, res) => {
  const tasks = db.get('tasks').filter({ userId:req.userId }).value();
  const logs = db.get('logs').filter({ userId:req.userId }).value();
  const today = isoLocal(new Date());
  const since = new Date(); since.setDate(since.getDate()-6); since.setHours(0,0,0,0);
  const completedToday = logs.filter(x=>x.date===today).length;
  const completed7 = logs.filter(x=>new Date(x.date+'T12:00:00')>=since).length;
  const byContext = {work:0,home:0,errands:0,personal:0,other:0};
  tasks.filter(t=>!t.done).forEach(t=>{ byContext[t.context||'other']=(byContext[t.context||'other']||0)+1; });
  res.json({ total:tasks.length, done:tasks.filter(t=>t.done).length, open:tasks.filter(t=>!t.done).length, completedToday, completed7, byContext });
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
    let steps = [];
    if(process.env.OPENAI_API_KEY){
      try{
        steps = await aiSplitTask(task.title);
      }catch(aiError){
        console.error('AI split failed, using local fallback:', aiError.message);
      }
    }
    if(!Array.isArray(steps) || steps.length < 2) steps = localSplit(task.title);
    if(!Array.isArray(steps) || steps.length < 2){
      return res.status(422).json({ error: process.env.OPENAI_API_KEY ? 'Не получилось разумно разбить эту задачу' : 'Для умного разбиения добавьте OPENAI_API_KEY' });
    }
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

// ---------- local conversational parsing ----------
app.post('/api/parse', auth, (req, res) => {
  const { text } = req.body;
  if(!text || !String(text).trim()) return res.status(400).json({ error: 'Нужен текст' });
  const parsed = localParseTasks(String(text));
  const tasks = parsed.map(t => ({
    id: crypto.randomUUID(), userId: req.userId, title: t.title,
    context: t.context, urgency: t.urgency, due: t.due,
    done: false, createdAt: Date.now()
  }));
  tasks.forEach(t => db.get('tasks').push(t).write());
  res.json(tasks);
});

function isoLocal(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function inferDue(text){
  const t=text.toLowerCase(), d=new Date(); d.setHours(12,0,0,0);
  if(/сегодня|до конца дня/.test(t)) return isoLocal(d);
  if(/завтра/.test(t)){ d.setDate(d.getDate()+1); return isoLocal(d); }
  if(/послезавтра/.test(t)){ d.setDate(d.getDate()+2); return isoLocal(d); }
  const days={воскресенье:0,понедельник:1,вторник:2,среду:3,среда:3,четверг:4,пятницу:5,пятница:5,субботу:6,суббота:6};
  for(const [word,target] of Object.entries(days)) if(t.includes(word)){
    let add=(target-d.getDay()+7)%7; if(add===0) add=7; d.setDate(d.getDate()+add); return isoLocal(d);
  }
  const m=t.match(/(?:до\s*)?(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/);
  if(m){ let y=m[3]?Number(m[3]):d.getFullYear(); if(y<100)y+=2000; return `${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`; }
  return null;
}
function inferContext(text){
  const t=text.toLowerCase();
  if(/убор|убрать|помыть|приготов|дом|квартир|ванн|полк|мебел|стир|комнат|кухн|пылесос|посуд/.test(t)) return 'home';
  if(/уч[её]б|практич|курсов|экзамен|зач[её]т|универ|лекци|домашн.*задан|проект|отч[её]т|работ|созвон|клиент|коллег|презентац|документ|таблиц/.test(t)) return 'work';
  if(/магазин|купить|забрать|пункт выдач|пвз|посылк|аптек|заехать|отнести|ателье|получить заказ/.test(t)) return 'errands';
  if(/врач|спорт|тренир|день рождения|мам|пап|друг|встреча|прогул/.test(t)) return 'personal';
  return 'other';
}
function inferUrgency(text){
  const t=text.toLowerCase();
  if(/срочно|важно|сегодня|прямо сейчас|горит|дедлайн/.test(t)) return 'high';
  if(/когда-нибудь|не срочно|если будет время/.test(t)) return 'low';
  return 'normal';
}
function localParseTasks(text){
  let chunks=String(text).replace(/\r/g,'\n').split(/\n+|;/i).map(x=>x.trim()).filter(Boolean);
  if(chunks.length===1 && /\s+и\s+(?=(?:не забыть|забрать|купить|сделать|доделать|позвонить|написать|отправить))/i.test(chunks[0]))
    chunks=chunks[0].split(/\s+и\s+(?=(?:не забыть|забрать|купить|сделать|доделать|позвонить|написать|отправить))/i);
  let lastObject='';
  chunks = chunks.map((raw,i)=>{
    let title=raw.trim();
    const obj=title.match(/(?:забрать|купить|получить|отнести)\s+([а-яёa-z-]+(?:\s+[а-яёa-z-]+)?)/i);
    if(obj) lastObject=obj[1].replace(/\s+(?:в|из|на|для)$/i,'').trim();
    if(lastObject && i>0){
      if(/измерить\s+длину(?!\s+[а-яё])/i.test(title)) title=title.replace(/измерить\s+длину/i, 'измерить длину '+lastObject);
    }
    return title;
  });
  return chunks.slice(0,12).map(title=>({ title:title.trim(), context:inferContext(title), urgency:inferUrgency(title), due:inferDue(title) }));
}

async function aiSplitTask(title){
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 20000);
  try{
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      signal:controller.signal,
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer '+process.env.OPENAI_API_KEY
      },
      body:JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        store:false,
        instructions:'Ты декомпозитор задач в приложении Flow. Разбей пользовательскую задачу на 2-7 конкретных, коротких и выполнимых шагов на русском языке. Сохраняй смысл, объекты и порядок действий. Не добавляй служебные фразы вроде "начать выполнение", "уточнить результат", "проверить результат", если пользователь этого не просил. Не придумывай адреса, сроки или факты. Верни ТОЛЬКО JSON-массив строк без markdown.',
        input:String(title).slice(0,1000),
        max_output_tokens:300
      })
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data?.error?.message || 'OpenAI API error '+response.status);
    const text = data.output_text || (data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
    const parsed=JSON.parse(String(text||'').trim());
    if(!Array.isArray(parsed)) throw new Error('AI returned invalid steps');
    return parsed.map(x=>String(x).trim()).filter(Boolean).slice(0,7);
  }finally{
    clearTimeout(timeout);
  }
}

function localSplit(title){
  const clean = String(title || '').trim().replace(/\s+/g,' ');
  if(!clean) return [];

  const normalize = s => String(s||'').replace(/^[,;.!?\s]+|[,;.!?\s]+$/g,'').replace(/^(?:и|затем|потом|после этого)\s+/i,'').trim();
  const cap = s => s ? s.charAt(0).toUpperCase()+s.slice(1) : s;

  // Сначала разбираем именно те действия, которые пользователь уже написал.
  // Важно: НЕ создаём служебные шаги вроде "уточнить результат" и "проверить результат".
  const actionRe = /\b(?:дойти|пойти|сходить|поехать|заехать|забрать|купить|получить|взять|отнести|занести|измерить|замерить|примерить|позвонить|написать|отправить|прибить|повесить|помыть|убрать|сдать|распечатать|проверить|сделать|доделать|подготовить|найти|заказать|записаться|оплатить|вернуть|отдать|загрузить|скачать|прочитать|выучить|собрать|разобрать|выбрать|составить|создать|оформить|организовать|спланировать|починить|постирать|пропылесосить|протереть|вынести|согласовать|изучить)\b/igu;
  const hits=[]; let m;
  while((m=actionRe.exec(clean))!==null) hits.push({index:m.index, verb:m[0].toLowerCase()});

  if(hits.length >= 2){
    let actions=hits.map((h,i)=>({
      verb:h.verb,
      text:normalize(clean.slice(h.index, hits[i+1]?.index ?? clean.length))
    })).filter(x=>x.text);

    // "пойти/дойти в ПВЗ забрать шторы" — одно законченное действие.
    const merged=[];
    for(let i=0;i<actions.length;i++){
      const cur=actions[i], next=actions[i+1];
      if(next && /^(?:дойти|пойти|сходить|поехать|заехать)$/.test(cur.verb) && /^(?:забрать|получить|купить|взять)$/.test(next.verb)){
        merged.push({verb:next.verb,text:normalize(cur.text+' '+next.text)}); i++;
      } else merged.push(cur);
    }
    actions=merged;

    // Определяем предмет и переносим его в следующие действия, где он опущен.
    let object='';
    const om=clean.match(/(?:забрать|купить|получить|взять)\s+([^,;.!?]+?)(?=\s+(?:и\s+)?(?:измерить|замерить|примерить|отнести|занести|вернуть|отдать)\b|[,;.!?]|$)/i);
    if(om){
      object=om[1].replace(/\s+(?:в|во|на|к|ко|из|для)\s+.*$/i,'').trim();
    }
    if(!object){
      const pron=clean.match(/(?:длину|размер|ширину|высоту)\s+([а-яёa-z0-9-]+)/i);
      if(pron) object=pron[1].trim();
    }

    const result=actions.map(({text,verb})=>{
      let x=normalize(text);
      if(object){
        x=x.replace(/\b(?:их|его|е[её])\s+(длину|ширину|высоту|размер)\b/ig,'$1 '+object);
        if(/^(?:отнести|занести|отдать|вернуть)\s+(?:в|во|на|к|ко)\b/i.test(x)){
          x=x.replace(/^((?:отнести|занести|отдать|вернуть))\s+/i,'$1 '+object+' ');
        }
      }
      return cap(normalize(x));
    }).filter(Boolean);

    if(result.length >= 2) return [...new Set(result)].slice(0,8);
  }

  const t=clean.toLowerCase();

  // Для действительно крупных одиночных задач используем конкретные локальные сценарии.
  if(/(?:убрать|убраться|генеральн.*уборк|навести порядок).*(?:дом|квартир|комнат)|(?:дом|квартир|комнат).*(?:убрать|уборк|порядок)/i.test(t))
    return ['Собрать вещи и освободить поверхности','Протереть пыль и поверхности','Пропылесосить или подмести пол','Помыть пол','Убрать кухню и ванную'];

  if(/(?:подготовиться|подготовка).*(?:экзамен|зач[её]т|контрольн|тест)/i.test(t))
    return ['Собрать материалы для подготовки','Составить список тем','Повторить основные темы','Решить практические задания','Повторить сложные темы'];

  if(/(?:сделать|подготовить|доделать|создать).*(?:проект|курсов|отч[её]т|презентац)/i.test(t))
    return ['Собрать требования и материалы','Составить структуру','Сделать основную часть','Проверить и исправить результат'];

  if(/(?:подготовиться|собраться|подготовка).*(?:поездк|путешеств|отпуск)|(?:поездк|путешеств|отпуск).*(?:подготов|собра)/i.test(t))
    return ['Проверить маршрут и даты','Проверить документы и бронирования','Составить список вещей','Собрать вещи','Проверить всё перед выходом'];

  if(/(?:организовать|подготовить|устроить).*(?:день рождения|праздник|вечеринк|мероприят)/i.test(t))
    return ['Определить дату, место и бюджет','Составить список гостей','Продумать еду и напитки','Купить необходимое','Подтвердить детали мероприятия'];

  if(/(?:переезд|переехать|переезжать)/i.test(t))
    return ['Составить список вещей','Разобрать и упаковать вещи','Отложить документы и ценности отдельно','Организовать перевозку','Проверить всё перед переездом'];

  // Если Flow не понимает, как полезно декомпозировать задачу, он не выдумывает
  // бессмысленные одинаковые шаги, а оставляет её как есть.
  return [clean];
}

// ---------- local smart planner ----------
app.get('/api/plan/today', auth, (req, res) => {
  const date = String(req.query.date || isoLocal(new Date()));
  const energyRec = db.get('energy').find({ userId:req.userId, date }).value();
  const energy = energyRec ? energyRec.level : 'normal';
  const all = db.get('tasks').filter({ userId:req.userId, done:false }).value();
  const maxItems = energy==='low' ? 2 : energy==='high' ? 5 : 3;
  const scored = all.map(t=>{
    let score=t.urgency==='high'?40:t.urgency==='low'?5:20;
    if(t.due){ const delta=Math.ceil((new Date(t.due+'T12:00:00')-new Date(date+'T12:00:00'))/86400000); if(delta<0)score+=80; else if(delta===0)score+=65; else if(delta===1)score+=45; else if(delta<=3)score+=25; }
    score += Math.max(0, 10-Math.floor((Date.now()-t.createdAt)/86400000));
    return {...t, score};
  }).sort((a,b)=>b.score-a.score || a.createdAt-b.createdAt);
  const plan=scored.slice(0,maxItems);
  const message = !plan.length ? 'На сегодня всё свободно.' : energy==='low' ? 'Сил немного — оставил только самое нужное.' : energy==='high' ? 'Энергии много — можно взять чуть больше задач.' : 'Собрал план по важности и срокам.';
  res.json({ date, energy, message, tasks:plan });
});

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
