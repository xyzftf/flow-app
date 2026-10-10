'use strict';
function category(text){
  if(/отч[её]т|проект|экзамен|уч[её]б|лекци|работ|курсов/i.test(text)) return 'work';
  if(/убра|убор|квартир|посуд|полк|штор|стир|ванн|кухн/i.test(text)) return 'home';
  if(/забра|посыл|пункт выдачи|купить|магазин|аптек/i.test(text)) return 'errands';
  if(/врач|трениров|прогул|мам|день рожден/i.test(text)) return 'personal';
  return 'other';
}
function parseLocal(text){
  // Keep objects such as “купить хлеб, молоко и сыр” together.
  const action='(?:купить|забрать|сделать|написать|позвонить|убрать|помыть|подготовить|отнести|измерить|оплатить|прочитать|доделать)';
  const boundary=new RegExp('[;\\n]+|(?:,|\\s+и|\\s+затем|\\s+потом)\\s+(?='+action+'\\s)','i');
  return text.split(boundary).map(s=>s.trim()).filter(Boolean).slice(0,30).map(title=>({title,context:category(title),urgency:/срочно|важно|немедленно/i.test(title)?'high':'normal',due:null}));
}
function splitLocal(text){
  if(/штор/i.test(text) && /забра|ателье|подши/i.test(text)) return ['Забрать шторы из пункта выдачи','Измерить нужную длину штор','Отнести шторы в ателье и сообщить нужную длину'];
  if(/убра|убор/i.test(text) && /квартир|дом|комнат/i.test(text)) return ['Собрать мусор и убрать вещи на места','Протереть пыль на поверхностях','Пропылесосить пол','Вымыть пол'];
  if(/полк/i.test(text) && /прибить|повесить|установить/i.test(text)) return ['Выбрать место для полки и проверить отсутствие скрытых проводов и труб','Подобрать крепёж под материал стены и подготовить инструменты','Разметить крепления по уровню','Закрепить полку и проверить устойчивость'];
  if(/отч[её]т/i.test(text) && /сделать|написать|подготовить|доделать/i.test(text)) return ['Уточнить требования и структуру отчёта','Собрать материалы для отчёта','Написать основные разделы','Проверить текст, оформление и выводы'];
  if(/проект/i.test(text) && /сделать|подготовить|начать/i.test(text)) return ['Определить результат проекта и требования','Разделить работу на основные этапы','Подготовить первую рабочую версию','Проверить результат по требованиям и исправить недочёты'];
  const parts=parseLocal(text).map(t=>t.title);
  return parts.length>1?parts:null;
}
function makePlan(tasks, energy, date){
  const limit={low:2,normal:3,high:6}[energy]||3;
  const reason=t=>t.due && t.due<=date?'Срок наступил':t.urgency==='high'?'Высокий приоритет':'Из текущих дел';
  const score=t=>(t.due && t.due<=date?100:0)+({high:30,normal:10,low:0}[t.urgency]||0);
  const open=tasks.filter(t=>!t.done).sort((a,b)=>score(b)-score(a)||(a.createdAt||0)-(b.createdAt||0));
  const chosen=open.slice(0,limit);
  return {ids:chosen.map(t=>t.id),reasons:Object.fromEntries(chosen.map(t=>[t.id,reason(t)])),remaining:open.length-chosen.length,energy};
}
module.exports={parseLocal,splitLocal,makePlan};
