'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function validDate(v){return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;}
function check(ok,message){if(!ok)throw new Error(message);}
function cleanText(v,max){check(typeof v==='string' && v.trim().length>0 && v.length<=max,'Проверьте название и его длину');return v.trim();}
function cleanSubtasks(items){
 check(Array.isArray(items)&&items.length<=100,'Не больше 100 подзадач');
 const seen=new Set();
 return items.map(s=>{check(s&&typeof s==='object','Неверная подзадача');const id=typeof s.id==='string'&&s.id.length<=80?s.id:crypto.randomUUID();check(!seen.has(id),'Повторяющийся шаг');seen.add(id);return {id,title:cleanText(s.title,500),done:s.done===true};});
}
function cleanRepeat(r,due){
 if(r===null)return null;
 check(r&&['daily','weekly','monthly'].includes(r.type),'Выберите период повторения');
 const d=new Date((due||dateKey(new Date()))+'T12:00:00');
 const result={type:r.type};
 if(r.type==='weekly'){result.weekday=r.weekday??d.getDay();check(Number.isInteger(result.weekday)&&result.weekday>=0&&result.weekday<=6,'Неверный день недели');}
 if(r.type==='monthly'){result.monthDay=r.monthDay??d.getDate();check(Number.isInteger(result.monthDay)&&result.monthDay>=1&&result.monthDay<=31,'Неверный день месяца');}
 return result;
}
function cleanReminder(r){
 if(r===null)return null;
 check(r&&Number.isInteger(r.daysBefore)&&r.daysBefore>=0&&r.daysBefore<=30&&typeof r.time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time),'Проверьте день и время напоминания');
 return {daysBefore:r.daysBefore,time:r.time};
}
function nextDate(task,today=dateKey(new Date())){
 const r=task.repeat;const anchor=task.due&&task.due>today?task.due:today;const d=new Date(anchor+'T12:00:00');
 if(r.type==='daily')d.setDate(d.getDate()+1);
 else if(r.type==='weekly'){let n=(r.weekday-d.getDay()+7)%7;d.setDate(d.getDate()+(n||7));}
 else{
  const day=r.monthDay;let y=d.getFullYear(),m=d.getMonth();
  let next=new Date(y,m,Math.min(day,new Date(y,m+1,0).getDate()),12);
  if(next<=d)next=new Date(y,m+1,Math.min(day,new Date(y,m+2,0).getDate()),12);
  return dateKey(next);
 }
 return dateKey(d);
}
function reminderTime(task){
 if(!task.due||!task.reminder)return null;
 const d=new Date(task.due+'T'+task.reminder.time+':00');d.setDate(d.getDate()-task.reminder.daysBefore);return d.getTime();
}
function installFeatures(app,auth,db,dataDir){
 db.defaults({trash:[]}).write();
 db.set('trash',db.get('trash').value().filter(x=>x.deletedAt>Date.now()-30*86400000)).write();
 const wrap=fn=>(req,res)=>{try{fn(req,res);}catch(e){res.status(400).json({error:e.message});}};
 const own=(req,res)=>{const t=db.get('tasks').find({id:req.params.id,userId:req.userId}).value();if(!t)res.status(404).json({error:'Задача не найдена'});return t;};
 app.get('/api/tasks',auth,(req,res)=>res.json(db.get('tasks').filter({userId:req.userId}).value()));
 app.post('/api/tasks',auth,wrap((req,res)=>{
  const title=cleanText(req.body.title,500),due=req.body.due||null;check(due===null||validDate(due),'Неверная дата');
  const t={id:crypto.randomUUID(),userId:req.userId,title,due,context:['work','home','errands','personal','other'].includes(req.body.context)?req.body.context:'other',urgency:['low','normal','high'].includes(req.body.urgency)?req.body.urgency:'normal',done:false,createdAt:Date.now(),subtasks:[]};
  db.get('tasks').push(t).write();res.json(t);
 }));
 app.put('/api/tasks/:id',auth,wrap((req,res)=>{
  const t=own(req,res);if(!t)return;
  const changes={};
  if('title'in req.body)changes.title=cleanText(req.body.title,500);
  if('due'in req.body){check(req.body.due===null||validDate(req.body.due),'Неверный срок');changes.due=req.body.due;}
  if(['work','home','errands','personal','other'].includes(req.body.context))changes.context=req.body.context;
  if(['low','normal','high'].includes(req.body.urgency))changes.urgency=req.body.urgency;
  if('subtasks'in req.body)changes.subtasks=cleanSubtasks(req.body.subtasks);
  if('repeat'in req.body)changes.repeat=cleanRepeat(req.body.repeat,changes.due??t.due);
  if('reminder'in req.body)changes.reminder=cleanReminder(req.body.reminder);
  const due='due'in changes?changes.due:t.due,reminder='reminder'in changes?changes.reminder:t.reminder;
  if(reminder&&!due){if(changes.due===null)changes.reminder=null;else throw new Error('Сначала укажите дедлайн');}
  if(('due'in changes&&changes.due!==t.due)||('reminder'in changes&&JSON.stringify(changes.reminder)!==JSON.stringify(t.reminder)))changes.remindedAt=null;
  const wasDone=t.done; if(typeof req.body.done==='boolean')changes.done=req.body.done;
  Object.assign(t,changes);
  if(!wasDone&&t.done){
   t.completedAt=Date.now();if(t.subtasks)t.subtasks.forEach(s=>s.done=true);
   db.get('logs').push({id:crypto.randomUUID(),userId:req.userId,taskId:t.id,text:t.title,date:dateKey(new Date()),createdAt:Date.now()}).value();
   if(t.repeat&&!t.nextOccurrenceId){
    const next={...t,id:crypto.randomUUID(),due:nextDate(t),done:false,completedAt:null,createdAt:Date.now(),remindedAt:null,subtasks:(t.subtasks||[]).map(s=>({...s,id:crypto.randomUUID(),done:false})),seriesId:t.seriesId||t.id};
    delete next.nextOccurrenceId;t.nextOccurrenceId=next.id;db.get('tasks').push(next).value();
   }
  }else if(wasDone&&!t.done){t.completedAt=null;db.get('logs').remove({userId:req.userId,taskId:t.id}).value();}
  db.write();res.json(t);
 }));
 app.delete('/api/tasks/:id',auth,(req,res)=>{
  const t=own(req,res);if(!t)return;
  const places=db.get('plans').filter({userId:req.userId}).value().filter(p=>(p.ids||[]).includes(t.id)).map(p=>({date:p.date,index:p.ids.indexOf(t.id)}));
  db.get('trash').push({id:t.id,userId:req.userId,task:JSON.parse(JSON.stringify(t)),places,deletedAt:Date.now()}).value();
  db.get('tasks').remove({id:t.id,userId:req.userId}).value();
  db.get('plans').filter({userId:req.userId}).value().forEach(p=>{p.ids=(p.ids||[]).filter(id=>id!==t.id);if(p.reasons)delete p.reasons[t.id];});
  db.write();res.json({ok:true,id:t.id});
 });
 app.get('/api/trash',auth,(req,res)=>res.json(db.get('trash').filter({userId:req.userId}).value().map(x=>({id:x.id,title:x.task.title,deletedAt:x.deletedAt}))));
 app.post('/api/trash/:id/restore',auth,(req,res)=>{
  const x=db.get('trash').find({id:req.params.id,userId:req.userId}).value();if(!x)return res.status(404).json({error:'Задача не найдена в корзине'});
  if(!db.get('tasks').find({id:x.id}).value())db.get('tasks').push(x.task).value();
  for(const place of x.places||[]){const p=db.get('plans').find({userId:req.userId,date:place.date}).value();if(p&&!p.ids.includes(x.id)&&!x.task.done)p.ids.splice(Math.min(place.index,p.ids.length),0,x.id);}
  db.get('trash').remove({id:x.id,userId:req.userId}).value();db.write();res.json({ok:true});
 });
 app.get('/api/notifications/due',auth,(req,res)=>{
  const items=db.get('tasks').filter({userId:req.userId,done:false}).value().filter(t=>!t.remindedAt&&reminderTime(t)!==null&&reminderTime(t)<=Date.now()).slice(0,5);
  res.json(items.map(t=>({id:t.id,title:t.title,due:t.due,key:String(reminderTime(t))})));
 });
 app.post('/api/notifications/:id/ack',auth,(req,res)=>{
  const t=own({...req,params:{id:req.params.id}},res);if(!t)return;
  if(String(reminderTime(t))!==req.body.key)return res.status(409).json({error:'Напоминание изменено'});
  t.remindedAt=Date.now();db.write();res.json({ok:true});
 });
 app.get('/api/backup',auth,(req,res)=>{
  const user=db.get('users').find({id:req.userId}).value();
  const collections={};for(const name of ['tasks','logs','energy','plans','reminders'])collections[name]=db.get(name).filter({userId:req.userId}).value().map(({userId,...rest})=>rest);
  res.json({format:'flow-backup',version:1,exportedAt:new Date().toISOString(),profile:{name:user.name||'',bio:user.bio||'',focus:user.focus||''},...collections});
 });
 app.post('/api/backup/import',auth,wrap((req,res)=>{
  const b=req.body;check(b&&b.format==='flow-backup'&&b.version===1&&Array.isArray(b.tasks)&&b.tasks.length<=5000,'Это не поддерживаемая резервная копия Flow');
  const ids=new Set();const mapping=new Map();const existing=db.get('tasks').value();
  const incoming=b.tasks.map(raw=>{
   check(raw&&typeof raw.id==='string'&&raw.id.length<=100&&!ids.has(raw.id),'Неверные идентификаторы задач');ids.add(raw.id);
   let id=raw.id;if(existing.some(t=>t.id===id&&t.userId!==req.userId))id='import-'+crypto.createHash('sha256').update(req.userId+':'+raw.id).digest('hex');mapping.set(raw.id,id);
   const due=raw.due||null;check(due===null||validDate(due),'Неверный дедлайн в копии');
   return {id,userId:req.userId,title:cleanText(raw.title,500),due,context:['work','home','errands','personal','other'].includes(raw.context)?raw.context:'other',urgency:['low','normal','high'].includes(raw.urgency)?raw.urgency:'normal',done:raw.done===true,createdAt:Number.isFinite(raw.createdAt)?raw.createdAt:Date.now(),completedAt:Number.isFinite(raw.completedAt)?raw.completedAt:null,subtasks:cleanSubtasks(raw.subtasks||[]),repeat:raw.repeat?cleanRepeat(raw.repeat,due):null,reminder:raw.reminder&&due?cleanReminder(raw.reminder):null,remindedAt:Number.isFinite(raw.remindedAt)?raw.remindedAt:null,nextOccurrenceId:typeof raw.nextOccurrenceId==='string'?raw.nextOccurrenceId:null};
  });
  incoming.forEach(t=>{t.nextOccurrenceId=mapping.get(t.nextOccurrenceId)||null;});
  const added=incoming.filter(t=>!existing.some(e=>e.id===t.id&&e.userId===req.userId));
  const records={};
  for(const name of ['logs','energy','plans','reminders']){check(b[name]===undefined||Array.isArray(b[name])&&b[name].length<=10000,'Неверные разделы копии');records[name]=[];}
  for(const x of b.logs||[]){check(x&&validDate(x.date),'Неверная дата истории');records.logs.push({id:typeof x.id==='string'?x.id:crypto.randomUUID(),userId:req.userId,text:cleanText(x.text,4000),date:x.date,taskId:mapping.get(x.taskId)||null,createdAt:Number.isFinite(x.createdAt)?x.createdAt:Date.now()});}
  for(const x of b.energy||[]){check(x&&validDate(x.date)&&['low','normal','high'].includes(x.level),'Неверная запись энергии');records.energy.push({userId:req.userId,date:x.date,level:x.level});}
  for(const x of b.plans||[]){check(x&&validDate(x.date)&&Array.isArray(x.ids)&&x.ids.length<=50,'Неверный план');records.plans.push({userId:req.userId,date:x.date,ids:[...new Set(x.ids.map(id=>mapping.get(id)).filter(Boolean))]});}
  for(const x of b.reminders||[]){check(x&&(x.time===null||/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time)),'Неверная настройка напоминания');records.reminders.push({userId:req.userId,time:x.time});}
  const profile={};for(const [k,max] of [['name',80],['bio',300],['focus',120]]){const value=b.profile?.[k];if(value!==undefined){check(typeof value==='string'&&value.length<=max,'Неверный профиль');profile[k]=value;}}
  fs.mkdirSync(path.join(dataDir,'backups'),{recursive:true});fs.copyFileSync(path.join(dataDir,'db.json'),path.join(dataDir,'backups',`before-import-${Date.now()}.json`));
  db.get('tasks').push(...added).value();
  db.get('trash').remove(x=>x.userId===req.userId&&added.some(t=>t.id===x.id)).value();
  for(const name of ['logs','energy','plans','reminders']){
   const key=name==='logs'?'id':name==='reminders'?'userId':'date';
   for(const x of records[name])if(!db.get(name).find(y=>y.userId===req.userId&&y[key]===x[key]).value())db.get(name).push(x).value();
  }
  const user=db.get('users').find({id:req.userId}).value();for(const k of Object.keys(profile))if(!user[k])user[k]=profile[k];
  db.write();res.json({ok:true,added:added.length,skipped:incoming.length-added.length});
 }));
}
module.exports={installFeatures,nextDate,reminderTime,cleanSubtasks};
