const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
test('profile, optional deadlines, deletion and account isolation persist',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-test-'));
 process.env.FLOW_DATA_DIR=dir;
 let running;
 try{
  running=await require('../server').startServer(0);
  let base='http://127.0.0.1:'+running.port;
  async function req(route,method='GET',body,token){
   const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
   return {status:r.status,data:await r.json()};
  }
  const register=async email=>(await req('/api/auth/register','POST',{email,password:'test-password'})).data.token;
  const a=await register('a@example.test'),b=await register('b@example.test');
  const t=(await req('/api/tasks','POST',{title:'Проверить отчёт'},a)).data;
  assert.equal(t.due,null);
  assert.equal((await req('/api/tasks/'+t.id,'PUT',{due:'2026-02-30'},a)).status,400);
  assert.equal((await req('/api/tasks/'+t.id,'PUT',{due:'2026-11-15'},a)).status,200);
  assert.equal((await req('/api/tasks','GET',null,a)).data[0].due,'2026-11-15');
  await req('/api/tasks/'+t.id,'PUT',{due:null},a);
  assert.equal((await req('/api/tasks','GET',null,a)).data[0].due,null);
  await req('/api/me','PUT',{name:'Друн',bio:'Изучаю ИБ',focus:'Закончить проект'},a);
  assert.equal((await req('/api/me','GET',null,a)).data.focus,'Закончить проект');
  assert.equal((await req('/api/me','GET',null,b)).data.bio,'');
  await req('/api/plan/2026-10-11','POST',{},a);
  assert.equal((await req('/api/tasks/'+t.id,'DELETE',null,b)).status,404);
  assert.equal((await req('/api/tasks','GET',null,a)).data.length,1);
  await req('/api/tasks/'+t.id,'DELETE',null,a);
  assert.deepEqual((await req('/api/plan/2026-10-11','GET',null,a)).data.ids,[]);
  await new Promise(r=>running.server.close(r));running=null;
  delete require.cache[require.resolve('../server')];
  running=await require('../server').startServer(0);base='http://127.0.0.1:'+running.port;
  assert.equal((await req('/api/tasks','GET',null,a)).data.length,0);
  assert.equal((await req('/api/me','GET',null,a)).data.bio,'Изучаю ИБ');
 }finally{
  if(running)await new Promise(r=>running.server.close(r));
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
