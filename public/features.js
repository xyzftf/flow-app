'use strict';
const expandedTasks=new Set();
let lastDeleted=null,libraryRequest=0,reminderInterval=null,reminderBusy=false;
function actionButton(text,fn){const b=document.createElement('button');b.type='button';b.className='task-action';b.textContent=text;b.onclick=fn;return b;}
async function refreshTaskViews(){await loadTasks();render();renderFullList();await loadSmartPlan();if(document.getElementById('tab-profile').style.display!=='none')await loadProfileStats();}
function showUndo(task){lastDeleted=task.id;document.getElementById('undoText').textContent='Удалено: '+task.title;document.getElementById('undoDelete').hidden=false;}
async function restoreDeleted(id){await api('/api/trash/'+id+'/restore',{method:'POST'});if(lastDeleted===id){lastDeleted=null;document.getElementById('undoDelete').hidden=true;}await refreshTaskViews();}
document.getElementById('undoButton').onclick=async function(){if(!lastDeleted)return;this.disabled=true;try{await restoreDeleted(lastDeleted);}catch(e){showGentleToast(e.message);}finally{this.disabled=false;}};
document.getElementById('dismissUndo').onclick=()=>document.getElementById('undoDelete').hidden=true;
for(const id of ['taskSearch','taskView','taskQuickFilter'])document.getElementById(id).addEventListener(id==='taskSearch'?'input':'change',()=>renderFullList());
async function renderLibrary(){
 const request=++libraryRequest,list=document.getElementById('fullList'),counter=document.getElementById('libraryCount');
 const view=document.getElementById('taskView').value,query=document.getElementById('taskSearch').value.trim().toLocaleLowerCase('ru'),quick=document.getElementById('taskQuickFilter').value;
 document.getElementById('taskQuickFilter').disabled=view==='trash';document.querySelectorAll('.filter-chip').forEach(b=>b.disabled=view==='trash');
 list.replaceChildren();
 if(view==='trash'){
  counter.textContent='Загрузка корзины…';
  try{
   const trash=await api('/api/trash');if(request!==libraryRequest)return;
   const found=trash.filter(t=>t.title.toLocaleLowerCase('ru').includes(query)).sort((a,b)=>b.deletedAt-a.deletedAt);
   counter.textContent=`Найдено: ${found.length}. Можно восстановить в течение 30 дней.`;
   for(const t of found){const row=document.createElement('div');row.className='trash-row';const title=document.createElement('span');title.textContent=t.title;
    const restore=actionButton('Восстановить',async()=>{restore.disabled=true;try{await restoreDeleted(t.id);}catch(e){showGentleToast(e.message);restore.disabled=false;}});row.append(title,restore);list.appendChild(row);}
   if(!found.length)list.textContent='Корзина пуста или нет совпадений.';
  }catch(e){if(request===libraryRequest)counter.textContent=e.message;}
  return;
 }
 const found=tasks.filter(t=>Boolean(t.done)===(view==='archive')).filter(t=>currentFilter==='all'||t.context===currentFilter).filter(t=>(t.title+' '+(t.subtasks||[]).map(s=>s.title).join(' ')).toLocaleLowerCase('ru').includes(query)).filter(t=>quick==='all'||quick==='today'&&t.due===todayKey()||quick==='overdue'&&!t.done&&t.due&&t.due<todayKey()||quick==='high'&&t.urgency==='high'||quick==='undated'&&!t.due);
 found.sort((a,b)=>view==='archive'?(b.completedAt||b.createdAt)-(a.completedAt||a.createdAt):urgencyRank(a.urgency)-urgencyRank(b.urgency)||a.createdAt-b.createdAt);
 counter.textContent=`${view==='archive'?'В архиве':'Активных'}: ${found.length}`;
 if(!found.length){list.textContent='Задач с такими условиями нет.';return;}
 found.forEach(t=>list.appendChild(renderTask(t)));
}
async function updateFeature(task,changes){const updated=await api('/api/tasks/'+task.id,{method:'PUT',body:JSON.stringify(changes)});Object.assign(task,updated);await refreshTaskViews();}
function addTaskFeatures(task,el){
 const body=el.querySelector('.task-body'),meta=el.querySelector('.task-meta');
 const steps=task.subtasks||[];
 const details=document.createElement('details');details.className='subtask-panel';details.open=expandedTasks.has(task.id);
 const summary=document.createElement('summary');summary.textContent=steps.length?`Подзадачи: ${steps.filter(s=>s.done).length} из ${steps.length}`:'＋ Добавить подзадачи';details.appendChild(summary);
 details.ontoggle=()=>{if(details.open)expandedTasks.add(task.id);else expandedTasks.delete(task.id);};
 const saveSteps=async list=>{expandedTasks.add(task.id);await updateFeature(task,{subtasks:list});};
 steps.forEach(step=>{
  const row=document.createElement('div');row.className='subtask-row'+(step.done?' completed':'');
  const check=document.createElement('input');check.type='checkbox';check.checked=step.done;check.disabled=task.done;check.setAttribute('aria-label','Шаг: '+step.title);
  const title=document.createElement('span');title.className='subtask-title';title.textContent=step.title;
  check.onchange=async()=>{check.disabled=true;try{await saveSteps(steps.map(s=>s.id===step.id?{...s,done:check.checked}:s));}catch(e){check.checked=step.done;check.disabled=false;showGentleToast(e.message);}};
  row.append(check,title);
  if(!task.done){
   row.appendChild(actionButton('Изменить',()=>{
    const editor=document.createElement('form');editor.className='subtask-add';const input=document.createElement('input');input.value=step.title;input.required=true;input.maxLength=500;input.setAttribute('aria-label','Название подзадачи');
    const save=document.createElement('button');save.className='task-action';save.type='submit';save.textContent='Сохранить';
    editor.append(input,save,actionButton('Отмена',()=>{editor.remove();row.hidden=false;}));row.after(editor);row.hidden=true;input.focus();
    editor.onsubmit=async ev=>{ev.preventDefault();if(!input.value.trim())return;save.disabled=true;try{await saveSteps(steps.map(s=>s.id===step.id?{...s,title:input.value.trim()}:s));}catch(e){save.disabled=false;showGentleToast(e.message);}};
   }));
   row.appendChild(actionButton('×',async()=>{if(!confirm('Удалить подзадачу «'+step.title+'»?'))return;try{await saveSteps(steps.filter(s=>s.id!==step.id));}catch(e){showGentleToast(e.message);}}));
  }
  details.appendChild(row);
 });
 if(!task.done){
  const form=document.createElement('form');form.className='subtask-add';const input=document.createElement('input');input.placeholder='Следующий шаг';input.setAttribute('aria-label','Новая подзадача');input.required=true;input.maxLength=500;
  const add=document.createElement('button');add.type='submit';add.className='task-action';add.textContent='Добавить';form.append(input,add);
  form.onsubmit=async ev=>{ev.preventDefault();if(!input.value.trim())return;add.disabled=true;try{await saveSteps([...steps,{title:input.value.trim(),done:false}]);}catch(e){showGentleToast(e.message);add.disabled=false;}};
  details.appendChild(form);
 }
 if(steps.length||!task.done)body.appendChild(details);
 if(task.done){meta.appendChild(actionButton('Вернуть из архива',async()=>{try{await updateFeature(task,{done:false});}catch(e){showGentleToast(e.message);}}));return;}
 meta.appendChild(actionButton(task.repeat?'Повтор: '+({daily:'каждый день',weekly:'еженедельно',monthly:'ежемесячно'}[task.repeat.type]):'Повторять',()=>openRepeat(task,body)));
 meta.appendChild(actionButton(task.reminder?'Напоминание: '+task.reminder.time:'Напомнить',()=>openReminder(task,body)));
}
function featureForm(body,kind){const existing=body.querySelector('.'+kind);if(existing){existing.remove();return null;}const form=document.createElement('form');form.className='feature-form '+kind;body.appendChild(form);return form;}
function openRepeat(task,body){
 const form=featureForm(body,'repeat-editor');if(!form)return;
 form.innerHTML='<label>Период<select name="type"><option value="daily">Каждый день</option><option value="weekly">Каждую неделю</option><option value="monthly">Каждый месяц</option></select></label><label class="weekly-field">День недели<select name="weekday"><option value="1">Понедельник</option><option value="2">Вторник</option><option value="3">Среда</option><option value="4">Четверг</option><option value="5">Пятница</option><option value="6">Суббота</option><option value="0">Воскресенье</option></select></label><label class="monthly-field">Число месяца<input name="monthDay" type="number" min="1" max="31" value="1"></label><p class="hint">Следующая задача появится после выполнения текущей. Пропущенные даты не создают кучу задач. Если нужного числа нет — берётся последний день месяца.</p><div class="feature-actions"><button class="task-action" type="submit">Сохранить повтор</button></div>';
 const type=form.elements.type;type.value=task.repeat?.type||'weekly';form.elements.weekday.value=String(task.repeat?.weekday??1);form.elements.monthDay.value=String(task.repeat?.monthDay??new Date((task.due||todayKey())+'T12:00:00').getDate());
 const visibility=()=>{form.querySelector('.weekly-field').hidden=type.value!=='weekly';form.querySelector('.monthly-field').hidden=type.value!=='monthly';form.elements.monthDay.disabled=type.value!=='monthly';};type.onchange=visibility;visibility();
 const submit=async repeat=>{form.querySelectorAll('button').forEach(b=>b.disabled=true);try{await updateFeature(task,{repeat});}catch(e){showGentleToast(e.message);form.querySelectorAll('button').forEach(b=>b.disabled=false);}};
 form.onsubmit=ev=>{ev.preventDefault();const repeat={type:type.value};if(type.value==='weekly')repeat.weekday=Number(form.elements.weekday.value);if(type.value==='monthly')repeat.monthDay=Number(form.elements.monthDay.value);submit(repeat);};
 form.querySelector('.feature-actions').append(actionButton('Не повторять',()=>submit(null)),actionButton('Отмена',()=>form.remove()));
}
function openReminder(task,body){
 if(!task.due){showGentleToast('Сначала укажи дедлайн задачи. Напоминание привязано к этой дате.');return;}
 const form=featureForm(body,'reminder-editor');if(!form)return;
 form.innerHTML='<label>За сколько дней до дедлайна<input name="daysBefore" type="number" min="0" max="30" value="0" required></label><label>Время по часам компьютера<input name="time" type="time" value="09:00" required></label><p class="hint">0 — в день дедлайна. Flow должен быть открыт или свёрнут. Без дедлайна напоминание отключается.</p><div class="feature-actions"><button class="task-action" type="submit">Сохранить напоминание</button></div>';
 form.elements.daysBefore.value=String(task.reminder?.daysBefore||0);form.elements.time.value=task.reminder?.time||'09:00';
 const submit=async reminder=>{form.querySelectorAll('button').forEach(b=>b.disabled=true);try{await updateFeature(task,{reminder});await pollReminders();}catch(e){showGentleToast(e.message);form.querySelectorAll('button').forEach(b=>b.disabled=false);}};
 form.onsubmit=ev=>{ev.preventDefault();submit({daysBefore:Number(form.elements.daysBefore.value),time:form.elements.time.value});};
 form.querySelector('.feature-actions').append(actionButton('Не напоминать',()=>submit(null)),actionButton('Отмена',()=>form.remove()));
}
function startReminderPolling(){stopReminderPolling();pollReminders();reminderInterval=setInterval(pollReminders,30000);}
function stopReminderPolling(){if(reminderInterval)clearInterval(reminderInterval);reminderInterval=null;}
async function pollReminders(){
 if(reminderBusy||!token||!window.flowDesktop)return;
 reminderBusy=true;const session=token;
 try{const notifications=await api('/api/notifications/due');for(const n of notifications){if(token!==session)break;const shown=await window.flowDesktop.notify('Flow · дедлайн',n.title+' — '+formatDue(n.due));if(shown&&token===session)await api('/api/notifications/'+n.id+'/ack',{method:'POST',body:JSON.stringify({key:n.key})});}}
 catch(e){/* Keep unsent reminders pending and retry while the app is open. */}finally{reminderBusy=false;}
}
document.getElementById('testNotification').onclick=async()=>{
 const status=document.getElementById('notificationStatus');
 if(!window.flowDesktop){status.textContent='Системные уведомления доступны в настольном Flow.';return;}
 try{const shown=await window.flowDesktop.notify('Flow','Напоминания включены. Так будет выглядеть уведомление о задаче.');status.textContent=shown?'Тестовое уведомление отправлено.':'Уведомление не показано. Проверь разрешение для Flow и режим «Не беспокоить» в Windows.';}catch(e){status.textContent='Не удалось показать уведомление.';}
};
document.getElementById('backupExport').onclick=async function(){
 this.disabled=true;const status=document.getElementById('backupStatus');
 try{const backup=await api('/api/backup');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Flow-backup-'+todayKey()+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='Файл копии передан на скачивание.';}catch(e){status.textContent=e.message;}finally{this.disabled=false;}
};
document.getElementById('backupImport').onclick=()=>document.getElementById('backupFile').click();
document.getElementById('backupFile').onchange=async function(){
 const file=this.files[0],status=document.getElementById('backupStatus');if(!file)return;
 try{
  if(file.size>5*1024*1024)throw new Error('Копия слишком большая: максимум 5 МБ.');
  const contents=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Не удалось прочитать файл'));reader.readAsText(file);});
  const backup=JSON.parse(contents);if(backup.format!=='flow-backup'||backup.version!==1||!Array.isArray(backup.tasks))throw new Error('Выбери JSON-копию, созданную Flow.');
  if(!confirm(`В копии ${backup.tasks.length} задач. Добавить отсутствующие задачи, историю и планы в текущий аккаунт? Существующие записи останутся без изменений.`))return;
  document.getElementById('backupImport').disabled=true;
  const result=await api('/api/backup/import',{method:'POST',body:JSON.stringify(backup)});await refreshTaskViews();await loadProfileName();
  status.textContent=`Добавлено задач: ${result.added}. Уже существовали: ${result.skipped}.`;
 }catch(e){status.textContent=e.message;}finally{this.value='';document.getElementById('backupImport').disabled=false;}
};
