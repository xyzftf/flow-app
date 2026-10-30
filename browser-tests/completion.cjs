const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
process.env.FLOW_DATA_DIR=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'flow-pointer-'));
(async()=>{
 const {server,port}=await require('../server').startServer(0);let browser;
 try{
  const base='http://127.0.0.1:'+port;
  const auth=await (await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'pointer@example.test',password:'test-password'})})).json();
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+auth.token};
  for(const title of ['Проверка мыши','Задача в плане'])await fetch(base+'/api/tasks',{method:'POST',headers,body:JSON.stringify({title})});
  browser=await chromium.launch({headless:true,...(process.env.FLOW_TEST_CHROMIUM?{executablePath:process.env.FLOW_TEST_CHROMIUM,args:['--no-sandbox','--disable-gpu']}: {})});
  const page=await browser.newPage({viewport:{width:1080,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(token=>localStorage.setItem('flowToken',token),auth.token);
  await page.goto(base);await page.locator('#adaptiveList .task').first().waitFor();
  const card=page.locator('#adaptiveList .task').filter({hasText:'Проверка мыши'});
  await card.getByRole('button',{name:'Добавить подзадачу',exact:true}).click();
  await card.getByRole('textbox',{name:'Новая подзадача'}).fill('Мой первый шаг');
  await card.locator('.subtask-add').getByRole('button',{name:'Добавить',exact:true}).click();
  await card.getByText('Мой первый шаг',{exact:true}).waitFor();
  await card.getByRole('checkbox',{name:'Шаг: Мой первый шаг'}).check();
  await card.getByText('Подзадачи: 1 из 1',{exact:true}).waitFor();
  // Real Playwright mouse hit testing, without force or programmatic DOM clicks.
  await card.locator('.checkbox').click();await card.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Составить / перестроить',exact:true}).click();
  const plan=page.locator('#smartPlanList .task').filter({hasText:'Задача в плане'});
  await plan.getByRole('button',{name:'Добавить подзадачу',exact:true}).click();
  await plan.getByRole('textbox',{name:'Новая подзадача'}).fill('Шаг из плана');
  await plan.locator('.subtask-add').getByRole('button',{name:'Добавить',exact:true}).click();
  await plan.getByText('Шаг из плана',{exact:true}).waitFor();
  await plan.getByRole('button',{name:'Выполнить',exact:true}).click();await plan.waitFor({state:'detached'});
  await page.locator('[data-tab="all"]').click();await page.locator('#taskView').selectOption('archive');
  await page.locator('#fullList .task').first().waitFor();assert.equal(await page.locator('#fullList .task').count(),2);
  await page.reload();await page.locator('[data-tab="all"]').click();await page.locator('#taskView').selectOption('archive');
  await page.locator('#fullList .task').first().waitFor();assert.equal(await page.locator('#fullList .task').count(),2);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS: real mouse completion and subtask creation in task list and daily plan, archive and reload');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(process.env.FLOW_DATA_DIR,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
