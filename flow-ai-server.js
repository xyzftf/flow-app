const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Temporary request diagnostics: Render logs will show every request that reaches this process.
app.use((req, res, next) => {
  console.log('[request]', new Date().toISOString(), req.method, req.originalUrl, 'host='+req.headers.host);
  next();
});

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FLOW_API_TOKEN = process.env.FLOW_API_TOKEN || '';

function auth(req, res, next){
  if(!FLOW_API_TOKEN) return next();
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if(token !== FLOW_API_TOKEN) return res.status(401).json({ error:'unauthorized' });
  next();
}

app.get('/', (req,res)=>res.json({ok:true, service:'Flow AI'}));
app.get('/health', (req,res)=>res.json({ok:true}));
app.get('/debug', (req,res)=>res.json({
  ok:true,
  service:'Flow AI',
  path:req.originalUrl,
  host:req.headers.host,
  port:PORT
}));

app.post('/split', auth, async (req,res)=>{
  const title=String(req.body?.title || '').trim().slice(0,1000);
  if(!title) return res.status(400).json({error:'Нужен текст задачи'});
  if(!OPENAI_API_KEY) return res.status(503).json({error:'AI backend не настроен'});

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),25000);
  try{
    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      signal:controller.signal,
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_API_KEY},
      body:JSON.stringify({
        model:process.env.OPENAI_MODEL || 'gpt-5-mini',
        store:false,
        instructions:'Ты декомпозитор задач в приложении Flow. Разбей задачу на 2-7 конкретных коротких выполнимых шагов на русском языке. Сохраняй смысл, объекты и естественный порядок действий. Не добавляй служебные фразы вроде "начать выполнение", "уточнить результат" или "проверить результат", если пользователь этого не просил. Не придумывай адреса, сроки или факты. Верни ТОЛЬКО JSON-массив строк без markdown.',
        input:title,
        max_output_tokens:300
      })
    });
    const data=await response.json();
    if(!response.ok) throw new Error(data?.error?.message || 'OpenAI API '+response.status);
    const text=data.output_text || (data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
    const steps=JSON.parse(String(text||'').trim());
    if(!Array.isArray(steps) || steps.length<2) throw new Error('Некорректный ответ модели');
    res.json({steps:steps.map(x=>String(x).trim()).filter(Boolean).slice(0,7)});
  }catch(e){
    console.error('split error:',e.message);
    res.status(502).json({error:'AI временно не смог разбить задачу'});
  }finally{ clearTimeout(timeout); }
});

app.listen(PORT,'0.0.0.0',()=>console.log('Flow AI listening on '+PORT));
