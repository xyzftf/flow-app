const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseLocal,splitLocal,makePlan}=require('../planner');
test('shopping list remains one task',()=>assert.equal(parseLocal('купить хлеб, молоко и сыр').length,1));
test('separate actions and categories',()=>{const t=parseLocal('купить хлеб и написать отчёт');assert.equal(t.length,2);assert.equal(t[1].context,'work');});
test('unknown task is not replaced with generic filler',()=>assert.equal(splitLocal('разобраться с ситуацией'),null));
test('curtains get concrete steps',()=>assert.equal(splitLocal('забрать шторы и отнести в ателье').length,3));
test('low energy limits load; due dates and done respected',()=>{const p=makePlan([{id:'a',urgency:'high'},{id:'b',due:'2026-10-10'},{id:'c',done:true,due:'2020-01-01'},{id:'d'}],'low','2026-10-11');assert.deepEqual(p.ids,['b','a']);assert.equal(p.remaining,1);});
