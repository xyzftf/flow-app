const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {nextDate,reminderTime}=require('../task-features');
test('recurrence handles month ends and skips missed occurrences',()=>{
 assert.equal(nextDate({due:'2026-01-31',repeat:{type:'monthly',monthDay:31}},'2026-01-31'),'2026-02-28');
 assert.equal(nextDate({due:'2026-02-28',repeat:{type:'monthly',monthDay:31}},'2026-02-28'),'2026-03-31');
 assert.equal(nextDate({due:'2026-10-05',repeat:{type:'weekly',weekday:1}},'2026-10-25'),'2026-10-26');
 assert.equal(nextDate({repeat:{type:'daily'}},'2026-12-31'),'2027-01-01');
 assert.equal(new Date(reminderTime({due:'2026-11-01',reminder:{daysBefore:1,time:'09:00'}})).getDate(),31);
});
test('subtasks, restore, recurring tasks, reminders and portable backup are isolated and persistent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-features-'));process.env.FLOW_DATA_DIR=dir;
 let running;
 try{
  running=await require('../server').startServer(0);let base='http://127.0.0.1:'+running.port;
  async function req(url,method='GET',body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  const register=async email=>(await req('/api/auth/register','POST',{email,password:'test-password'})).data.token;
  const a=await register('one@example.test'),b=await register('two@example.test');
  const call=(url,method,body)=>req(url,method,body,a);
  const t=(await call('/api/tasks','POST',{title:'убрать квартиру',due:'2026-10-25'})).data;
  const split=await call('/api/tasks/'+t.id+'/split','POST',{});assert.equal(split.data.id,t.id);assert.equal(split.data.subtasks.length,4);
  assert.equal((await call('/api/tasks')).data.length,1);
  assert.equal((await call('/api/tasks/'+t.id+'/split','POST',{})).status,409);
  assert.equal((await req('/api/tasks/'+t.id,'PUT',{subtasks:[]},b)).status,404);
  await call('/api/tasks/'+t.id,'PUT',{repeat:{type:'monthly',monthDay:31},reminder:{daysBefore:1,time:'09:00'},due:'2020-01-31'});
  let due=(await call('/api/notifications/due')).data;assert.equal(due.length,1);
  assert.equal((await call('/api/notifications/'+t.id+'/ack','POST',{key:'invalid'})).status,409);
  await call('/api/notifications/'+t.id+'/ack','POST',{key:due[0].key});assert.equal((await call('/api/notifications/due')).data.length,0);
  await call('/api/tasks/'+t.id,'PUT',{due:null});assert.equal((await call('/api/tasks')).data[0].reminder,null);
  await call('/api/tasks/'+t.id,'PUT',{done:true});await call('/api/tasks/'+t.id,'PUT',{done:true});
  let all=(await call('/api/tasks')).data;assert.equal(all.length,2);assert.equal(all.filter(t=>!t.done).length,1);assert(all.find(x=>x.id===t.id).subtasks.every(s=>s.done));assert(all.find(x=>x.id!==t.id).subtasks.every(s=>!s.done));
  const countLog=JSON.parse(fs.readFileSync(path.join(dir,'db.json'))).logs.length;assert.equal(countLog,1);
  await call('/api/tasks/'+t.id,'PUT',{done:false});await call('/api/tasks/'+t.id,'PUT',{done:true});assert.equal((await call('/api/tasks')).data.length,2);
  const active=all.find(x=>x.id!==t.id);await call('/api/plan/2026-10-25','POST',{});
  await call('/api/tasks/'+active.id,'DELETE');assert.equal((await call('/api/trash')).data.length,1);
  assert.equal((await req('/api/trash/'+active.id+'/restore','POST',{},b)).status,404);
  await call('/api/trash/'+active.id+'/restore','POST',{});assert.equal((await call('/api/tasks')).data.length,2);assert((await call('/api/plan/2026-10-25')).data.ids.includes(active.id));
  const backup=(await call('/api/backup')).data;assert(!JSON.stringify(backup).includes('passwordHash'));assert(!JSON.stringify(backup).includes('userId'));
  const invalid=JSON.parse(JSON.stringify(backup));invalid.tasks[0].due='2026-02-30';assert.equal((await req('/api/backup/import','POST',invalid,b)).status,400);assert.equal((await req('/api/tasks','GET',undefined,b)).data.length,0);
  assert.equal((await req('/api/backup/import','POST',backup,b)).data.added,2);
  // Repeat import into another account must also be idempotent.
  assert.equal((await req('/api/backup/import','POST',backup,b)).data.added,0);
  assert.equal((await call('/api/tasks')).data.length,2);
  assert.equal((await call('/api/backup/import','POST',backup)).data.added,0);
  await call('/api/tasks/'+active.id,'DELETE');
  await new Promise(r=>running.server.close(r));running=null;delete require.cache[require.resolve('../server')];running=await require('../server').startServer(0);base='http://127.0.0.1:'+running.port;
  assert.equal((await call('/api/trash')).data.length,1);await call('/api/trash/'+active.id+'/restore','POST',{});assert.equal((await call('/api/tasks')).data.length,2);
 }finally{if(running)await new Promise(r=>running.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
